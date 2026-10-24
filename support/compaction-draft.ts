import { randomUUID } from "node:crypto";
import { getLatestCompactionEntry, type FileOperations } from "@earendil-works/pi-coding-agent";
import type {
  CompactionResult,
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";

import type { CompactionState } from "./compaction-state.ts";
import { compactionAttemptType, fingerprint, readObservation, type CompactionObservation } from "./compaction-observation.ts";
import { checkpointSections, requestCheckpoint } from "./compaction-request.ts";

export { scheduleCheck, suspend, invalidate, dispose, type CompactionState } from "./compaction-state.ts";
export { observeRequest, observePayload, readObservation, reconstructRequest } from "./compaction-observation.ts";
export { requestCheckpoint } from "./compaction-request.ts";

// Manual extraction is implemented. Default activation and automatic policy wait
// for their later phases; isolated integration profiles can exercise this path.
export const compactionImplemented = false;

type CompactionDecision =
  | { kind: "compact"; trigger: "size" | "expiry" }
  | { kind: "wait"; checkAt: number }
  | { kind: "skip"; reason: string };

// Pure policy: soft size target, or known expiry with sufficiently large context.
// Unknown TTL means no expiry deadline; suppress unchanged failed attempts.
export function decideCompaction(_input: {
  observation: CompactionObservation;
  contextUsage: ContextUsage | undefined;
  now: number;
}): CompactionDecision {
  throw new Error("Compaction policy is not implemented");
}

// Clear the timer, establish attempt identity, and record its start in the session.
export function beginAttempt(
  state: CompactionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  trigger: "size" | "expiry" | "manual",
): void {
  if (state.disposed) throw new Error("The compaction runtime is disposed");
  if (state.attempt) throw new Error("A compaction attempt is already owned");
  clearTimeout(state.timer);
  state.timer = undefined;

  const observation = readObservation(ctx);
  const attempt: NonNullable<CompactionState["attempt"]> = {
    id: randomUUID(),
    sessionId: ctx.sessionManager.getSessionId(),
    generation: state.generation,
    trigger,
    controller: new AbortController(),
    requestId: observation.requestId,
    phase: "extracting",
  };
  state.attempt = attempt;
  pi.appendEntry(compactionAttemptType, {
    attemptId: attempt.id, sessionId: attempt.sessionId, requestId: attempt.requestId,
    trigger, outcome: "started",
  });
}

// Establish a manual attempt if needed. Reconstruct the warm prefix; append
// checkpoint instructions; verify provider serialization before one request.
// No tool execution, uncached fallback, or continuation. Validate output and recheck
// cancellation/source identity before returning Pi's preparation boundary.
// Reload does not abort event.signal: use the attempt's own controller too,
// returning cancellation without touching ctx once its runtime is invalidated.
export async function generateCheckpoint(
  state: CompactionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
): Promise<{ compaction: CompactionResult } | { cancel: true }> {
  if (state.disposed || event.reason !== "manual") return { cancel: true };
  let attempt: CompactionState["attempt"];
  try {
    beginAttempt(state, pi, ctx, "manual");
    attempt = state.attempt;
    if (!attempt) throw new Error("The manual compaction attempt was not created");

    const sourceFingerprint = fingerprint(ctx.sessionManager.getBranch());
    const response = await requestCheckpoint(ctx, event, attempt.controller.signal);
    // requestCheckpoint revalidates the source after generation. Recheck runtime
    // ownership too, before any more context access or handing output to Pi.
    if (state.disposed || state.attempt !== attempt || state.generation !== attempt.generation) {
      throw new Error("The compaction attempt is no longer current");
    }
    event.signal.throwIfAborted();
    attempt.controller.signal.throwIfAborted();
    if (ctx.sessionManager.getSessionId() !== attempt.sessionId || fingerprint(ctx.sessionManager.getBranch()) !== sourceFingerprint) {
      throw new Error("The checkpoint source changed before acceptance");
    }
    const text = validatedCheckpoint(response);
    const previousDetails = getLatestCompactionEntry(event.branchEntries)?.details;
    const checkpoint = withFileOperations(text, event.preparation.fileOps, previousDetails);
    attempt.phase = "ready";
    return {
      compaction: {
        summary: checkpoint.summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
        details: {
          readFiles: checkpoint.readFiles,
          modifiedFiles: checkpoint.modifiedFiles,
          checkpoint: { version: 1, attemptId: attempt.id, requestId: attempt.requestId },
        },
      },
    };
  } catch (error) {
    // Do not consult ctx here: reload can invalidate it while the request awaits.
    if (attempt && state.attempt === attempt) {
      attempt.phase = "rejected";
      attempt.failureOutcome = event.signal.aborted || attempt.controller.signal.aborted ? "cancelled" : "failed";
      attempt.errorMessage = error instanceof Error ? error.message : "Checkpoint generation failed";
      attempt.controller.abort();
    }
    return { cancel: true };
  }
}

function validatedCheckpoint(response: Awaited<ReturnType<typeof requestCheckpoint>>): string {
  if (response.stopReason !== "stop") {
    throw new Error(`Checkpoint generation did not finish normally (${response.stopReason})`);
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("Checkpoint generation returned a tool call");
  }
  const summary = response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim();
  if (!summary) throw new Error("Checkpoint generation returned no text");

  // A small structural check, not a claim of semantic fidelity.
  const headings = [...summary.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  for (const section of checkpointSections) {
    const index = headings.findIndex((heading) => heading[1].trim() === section.heading);
    if (index < 0) throw new Error(`Checkpoint is missing section: ${section.heading}`);
    const heading = headings[index];
    const body = summary.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? summary.length);
    if (!body.trim()) throw new Error(`Checkpoint section is empty: ${section.heading}`);
  }
  return summary;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withFileOperations(text: string, fileOps: FileOperations, previousDetails: unknown): {
  summary: string; readFiles: string[]; modifiedFiles: string[];
} {
  const read = new Set(fileOps.read);
  const modified = new Set([...fileOps.written, ...fileOps.edited]);
  if (object(previousDetails)) {
    if (Array.isArray(previousDetails.readFiles)) {
      for (const path of previousDetails.readFiles) if (typeof path === "string") read.add(path);
    }
    if (Array.isArray(previousDetails.modifiedFiles)) {
      for (const path of previousDetails.modifiedFiles) if (typeof path === "string") modified.add(path);
    }
  }
  const readFiles = [...read].filter((path) => !modified.has(path)).sort();
  const modifiedFiles = [...modified].sort();
  const sections = [text.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "").trim()];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return { summary: sections.join("\n\n"), readFiles, modifiedFiles };
}

// Correlate Pi's outcome with the current attempt; record it and release transient
// work. Ignore unowned/stale outcomes before reading ctx: late disposal outcomes
// can carry an invalid context. Do not retry or claim generation itself committed.
export function finishAttempt(
  state: CompactionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: SessionCompactEvent | SessionCompactFailedEvent,
): void {
  const attempt = state.attempt;
  if (!attempt || state.disposed || attempt.phase === "extracting") return;
  if (event.reason !== "manual" || attempt.trigger !== "manual") return;
  if (event.type === "session_compact") {
    const details = event.compactionEntry.details;
    if (!event.fromExtension || !object(details) || !object(details.checkpoint)) return;
    if (details.checkpoint.attemptId !== attempt.id) return;
  }

  // Unowned outcomes above never touch ctx. A canceled old generation can still
  // release ownership, but must not write into its replacement session/runtime.
  state.attempt = undefined;
  attempt.controller.abort();
  if (state.generation !== attempt.generation) return;
  if (ctx.sessionManager.getSessionId() !== attempt.sessionId) return;

  const outcome = event.type === "session_compact" ? "committed"
    : attempt.failureOutcome ?? (event.aborted ? "cancelled" : "failed");
  pi.appendEntry(compactionAttemptType, {
    attemptId: attempt.id, sessionId: attempt.sessionId, requestId: attempt.requestId,
    trigger: attempt.trigger, outcome,
    ...(event.type === "session_compact" ? { compactionEntryId: event.compactionEntry.id } : {}),
  });
  if (event.type === "session_compact_failed" && ctx.hasUI) {
    ctx.ui.notify(attempt.errorMessage ?? event.errorMessage ?? "Checkpoint cancelled; context preserved", "warning");
  }
}
