import {
  buildSessionProjection,
  convertToLlm,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { fingerprint, readObservation, reconstructRequest, type RequestObservation } from "./compaction-observation.ts";
import { defaultCompactionConfig, type CompactionConfig } from "./compaction-config.ts";

type Message = ReturnType<typeof convertToLlm>[number];
type CheckpointResponse = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;

export const checkpointSections = [
  {
    heading: "Intent",
    instruction: "The current objective, expected outcome, and scope of unfinished work at the cutoff.",
  },
  {
    heading: "Constraints and Authority",
    instruction: `Binding instructions, prohibitions, scope, and what the user has or has not authorized.
Preserve still-applicable skill names/paths and governing rules for unfinished work. When full instructions are needed, require reloading the skill before governed work.
Do not invent restrictions, approval gates, or skill relevance, or claim a skill has been reloaded.`,
  },
  {
    heading: "Progress and Findings",
    instruction: `Only decisions and findings that still affect unfinished work, with exact identifiers where needed.
Drop superseded investigations and historical accomplishments with no continuing consequence. Omit them entirely, not as caveats about their irrelevance.`,
  },
  {
    heading: "Uncertainty and Verification",
    instruction: `Current open questions, unresolved failures, and confidence in the current state.
Mention verification only when it still supports that state, with its relevant scope and limits. Distinguish source inspection, offline fixtures, and live evidence when consequential; do not invent results.
Discard stale routine test passes. Never imply that tests run before later changes verify those changes.`,
  },
  {
    heading: "Current State",
    instruction: `Unfinished work, blockers, and immediate workspace/runtime state. Include outstanding operations, effects, or IDs needed to avoid repeating work.
Keep source paths and symbols only where they help resume. Touched files do not establish an active working set; current sources are authoritative, not old read outputs.`,
  },
  {
    heading: "Next Action",
    instruction: `Preserve the concrete next step already agreed or required before the cutoff.
If a user decision is needed, state the exact question to ask, not a generic wait. Describe the step without executing it or granting new authority.`,
  },
] as const;

function messageOpening(message: Message): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content.trim().slice(0, 400) || undefined;

  const text = message.content.flatMap((block) => {
    if (block.type === "text") return [block.text];
    if (block.type === "toolCall") return [`[tool call: ${block.name} ${JSON.stringify(block.arguments)}]`];
    return [];
  }).join("\n");
  return text.trim().slice(0, 400) || undefined;
}

function checkpointInstruction(event: SessionBeforeCompactEvent, messages: Message[]): string {
  const projectedEntries = buildSessionProjection(event.branchEntries).entries;
  const boundaryIndex = projectedEntries.findIndex((entry) => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
  if (boundaryIndex < 0) throw new Error("The retained-tail boundary is no longer on the branch");

  const retainedMessages = convertToLlm(projectedEntries.slice(boundaryIndex).flatMap((entry) => entry.messages));
  const firstRetained = retainedMessages[0];
  if (!firstRetained) throw new Error("The retained tail has no model-visible message");
  const retainedFingerprint = fingerprint(firstRetained);
  const retainedIndex = messages.findLastIndex((message) => fingerprint(message) === retainedFingerprint);
  const opening = messageOpening(firstRetained);
  if (retainedIndex < 0 || !opening) throw new Error("The retained tail cannot be identified in the checkpoint request");

  const occurrenceFromEnd = messages.slice(retainedIndex).filter((message) => messageOpening(message) === opening).length;
  const focus = event.customInstructions?.trim();
  return `Stop working on the task. Do not call tools or execute any next action. Write only a context checkpoint for a successor.

Summarize the conversation BEFORE the retained tail. The final ${messages.length - retainedIndex} messages remain verbatim in context. The first retained message begins with the text below; use occurrence ${occurrenceFromEnd} of that opening, counting backward from the end. Tool calls in the opening are written as [tool call: name arguments].

<retained-tail-start>
${opening}
</retained-tail-start>

Treat that message and everything after it as not yet happened. Do not duplicate the recent exchanges that remain verbatim. Fold any earlier checkpoint into the new checkpoint, discarding superseded material.

Write a current-state handoff, not a changelog. Older tool calls normally leave nothing behind: retain a resulting fact only if it still matters. Do not catalogue calls, their intentions, old file contents, or routine successes.
Do not reread files, reload skills, or scan the repository while producing this checkpoint.

Use these headings:
${checkpointSections.map((section) => `## ${section.heading}\n${section.instruction}`).join("\n")}

Preserve important facts even when concise. Do not turn plans into completed work. Goal management remains external to this checkpoint.${focus ? `\n\nAdditional summary focus:\n${focus}` : ""}`;
}

// Replay strategy follows nicobailon/pi-cached-compaction. Here the captured
// payload is represented by hashes and nonsecret settings, not a second prompt
// store. Preserve Codex tool choice and definitions; never execute returned calls.
function checkpointPayload(params: unknown, request: RequestObservation): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("The checkpoint provider payload is not an object");
  }
  const parameters = request.parameters;
  if (!parameters) throw new Error("The captured request has no replay settings");

  // streamSimple omits provider-specific options. Restore the observed settings
  // explicitly, just as the reference restores captured request-only fields.
  const payload: Record<string, unknown> = {
    ...params,
    text: { verbosity: parameters.verbosity },
    tool_choice: parameters.toolChoice,
  };
  if (parameters.reasoning) payload.reasoning = parameters.reasoning;
  else delete payload.reasoning;
  if (parameters.temperature !== undefined) payload.temperature = parameters.temperature;
  else delete payload.temperature;
  if (parameters.serviceTier !== undefined) payload.service_tier = parameters.serviceTier;
  else delete payload.service_tier;

  if (!Array.isArray(payload.input) || payload.input.length <= request.prefix.inputCount) {
    throw new Error("The checkpoint request does not extend the captured input");
  }
  const replayedPrefix = {
    ...payload,
    input: payload.input.slice(0, request.prefix.inputCount),
  };
  if (fingerprint(replayedPrefix) !== request.payloadFingerprint) {
    throw new Error("The checkpoint request differs from the captured provider prefix");
  }
  return payload;
}

// Request layer only: no response acceptance, session replacement, or task
// continuation. The caller owns the extraction signal (including reload abort)
// and must translate errors into explicit compaction cancellation, not fallback.
export async function requestCheckpoint(
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  extractionSignal: AbortSignal,
  configuration: CompactionConfig = defaultCompactionConfig,
): Promise<CheckpointResponse> {
  const signal = AbortSignal.any([event.signal, extractionSignal]);
  signal.throwIfAborted();
  if (event.reason !== "manual") throw new Error("Only manual checkpoint requests are implemented");

  const observation = readObservation(ctx, configuration);
  if (observation.eligibility.kind !== "candidate" || !observation.request) {
    throw new Error(`Checkpoint unavailable: ${observation.eligibility.reason}`);
  }
  const request = observation.request;
  const transport = request.transport;
  if (transport !== "sse" && transport !== "auto") throw new Error("Unsupported checkpoint transport");
  if (observation.cache && Date.now() >= observation.cache.expiresAt) {
    throw new Error("The checkpoint cache deadline has passed");
  }
  const model = ctx.model;
  if (!model) throw new Error("No model is selected for checkpoint generation");
  const sourceLeaf = ctx.sessionManager.getLeafId();
  const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
  const sourceFingerprint = fingerprint(messages);
  const instruction = checkpointInstruction(event, messages);

  function checkSource(): void {
    // Test the caller-owned signal before accessing a possibly invalid context.
    signal.throwIfAborted();
    if (ctx.sessionManager.getSessionId() !== request.sessionId || ctx.sessionManager.getLeafId() !== sourceLeaf) {
      throw new Error("The checkpoint source changed during request generation");
    }
    const reconstructed = reconstructRequest(ctx, request);
    if (reconstructed.kind === "unavailable") throw new Error(`Checkpoint unavailable: ${reconstructed.reason}`);
    if (fingerprint(convertToLlm(ctx.sessionManager.buildSessionProjection().messages)) !== sourceFingerprint) {
      throw new Error("The checkpoint context changed during request generation");
    }
  }

  // Keep Pi's session/transport handling, including auto's cached WebSocket
  // deltas. onPayload still compares the full logical prefix before that step.
  let prefixVerified = false;
  const response = await ctx.modelRegistry.streamSimple(model, {
    messages: [...messages, { role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() }],
  }, {
    sessionId: request.sessionId,
    transport,
    signal,
    maxRetries: 0,
    maxTokens: Math.min(Math.floor(0.8 * event.preparation.settings.reserveTokens), model.maxTokens > 0 ? model.maxTokens : Infinity),
    toolChoice: request.parameters?.toolChoice,
    onPayload(params) {
      checkSource();
      const current = readObservation(ctx, configuration);
      if (current.cache && Date.now() >= current.cache.expiresAt) {
        throw new Error("The checkpoint cache deadline passed before sending");
      }
      const payload = checkpointPayload(params, request);
      prefixVerified = true;
      return payload;
    },
  }).result();

  checkSource();
  if (!prefixVerified) throw new Error(response.errorMessage ?? "The provider did not verify the checkpoint prefix");
  return response;
}
