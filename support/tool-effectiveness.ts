import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const TRACE_TYPE = "tool-effectiveness";
const CAPTURE_TYPE = "tool-effectiveness-capture";

interface TriggerMessage {
  text: string;
  imageCount: number;
}

interface CallEvidence {
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  turnIndex: number;
  triggerMessageIndex: number;
  arguments: unknown;
  query?: string;
  startedAt: number;
  durationMs?: number;
  status: "unfinished" | "returned" | "error";
  resultText?: string;
  nonTextResultCount?: number;
}

interface EffectivenessTrace {
  schemaVersion: 1;
  requestId: string;
  sessionId: string;
  branchLeafBeforeRun: string | null;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  endedBy?: string;
  // Most recent delivered user message is context, not inferred causal intent.
  messages: TriggerMessage[];
  calls: CallEvidence[];
  responses: Array<{
    turnIndex: number;
    text: string;
    provider: string;
    model: string;
    stopReason: string;
  }>;
}

function textContent(content: unknown): { text: string; nonTextCount: number } {
  if (typeof content === "string") return { text: content, nonTextCount: 0 };
  if (!Array.isArray(content)) return { text: "", nonTextCount: 0 };
  const texts: string[] = [];
  let nonTextCount = 0;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    else nonTextCount++;
  }
  return { text: texts.join("\n"), nonTextCount };
}

function preview(text: string, limit = 180): string {
  const singleLine = text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? `${singleLine.slice(0, limit)}…` : singleLine;
}

/** Request-level evidence, separate from raw provider/availability debugging. */
export function registerToolEffectiveness(pi: ExtensionAPI): void {
  let enabled = false;
  let current: EffectivenessTrace | undefined;
  let turnIndex = 0;

  function finish(endedBy: string): void {
    if (!current) return;
    current.endedAt = Date.now();
    current.endedBy = endedBy;
    pi.appendEntry<EffectivenessTrace>(TRACE_TYPE, current);
    current = undefined;
  }

  pi.registerEntryRenderer<EffectivenessTrace>(TRACE_TYPE, (entry, { expanded }, theme) => {
    const trace = entry.data;
    if (!trace) return new Text("[tool effectiveness] Missing trace", 0, 0);
    const direct = trace.calls.filter((call) => !call.parentToolCallId);
    const searches = direct.filter((call) => call.query !== undefined);
    const lines = [
      theme.fg("accent", `[tool effectiveness] ${searches.length} queries · ${direct.length} tool calls`),
      `Message: ${preview(trace.messages[0]?.text ?? "")}`,
    ];
    for (const call of searches) {
      lines.push(`${call.toolName}: ${preview(JSON.stringify(call.query))} → ${call.status}`);
    }
    if (expanded) {
      lines.push("", "Message excerpts (full text in export):");
      trace.messages.forEach((message, index) => {
        lines.push(`[${index}] ${preview(message.text, 4000)}`);
        if (message.imageCount) lines.push(`  ${message.imageCount} attached images (not copied)`);
      });
      lines.push("", "Evidence in call-start order (nested calls are not extra model queries):");
      for (const call of trace.calls) {
        lines.push(
          `Turn ${call.turnIndex} · message ${call.triggerMessageIndex} · ${call.toolName}${call.parentToolCallId ? " (nested)" : ""} · ${call.status}`,
          `  Arguments: ${preview(JSON.stringify(call.arguments), 500)}`,
          `  Result: ${preview(call.resultText ?? "No result recorded", 500)}`,
        );
      }
      lines.push("", "Full text, arguments, results, and responses: /tool-effectiveness export");
    } else {
      lines.push(keyHint("app.tools.expand", "to inspect evidence"));
    }
    return new Text(lines.join("\n"), 1, 1);
  });

  pi.registerCommand("tool-effectiveness", {
    description: "Capture request-level query evidence: on, off, status, or export",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "export") {
        const traces = ctx.sessionManager.getBranch().flatMap((entry) =>
          entry.type === "custom" && entry.customType === TRACE_TYPE && entry.data
            ? [entry.data as EffectivenessTrace]
            : [],
        );
        if (!traces.length) {
          ctx.ui.notify("No effectiveness traces on this branch. Run /tool-effectiveness on, then send a request.", "warning");
          return;
        }
        // Runtime evidence stays outside the source tree. Export only this branch.
        const dir = await mkdtemp(join(tmpdir(), "pi-tool-effectiveness-"));
        const path = join(dir, "traces.jsonl");
        await writeFile(path, traces.map((trace) => JSON.stringify(trace)).join("\n") + "\n", { mode: 0o600 });
        ctx.ui.notify(`Exported ${traces.length} request traces to ${path}`, "info");
        return;
      }
      if (action === "on" || action === "off") {
        if (action === "off") finish("capture_disabled");
        enabled = action === "on";
        pi.appendEntry(CAPTURE_TYPE, { enabled });
        ctx.ui.setStatus(TRACE_TYPE, enabled ? "tool effectiveness" : undefined);
      } else if (action !== "status") {
        ctx.ui.notify("Usage: /tool-effectiveness [on|off|status|export]", "warning");
        return;
      }
      ctx.ui.notify(
        `Tool effectiveness capture ${enabled ? "enabled for subsequent requests; prompts and result text are saved in this session" : "disabled"}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    current = undefined;
    enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CAPTURE_TYPE) {
        enabled = (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
      }
    }
    ctx.ui.setStatus(TRACE_TYPE, enabled ? "tool effectiveness" : undefined);
  });

  pi.on("before_agent_start", (event, ctx) => {
    finish("next_request");
    if (!enabled) return;
    turnIndex = 0;
    current = {
      schemaVersion: 1,
      requestId: randomUUID(),
      sessionId: ctx.sessionManager.getSessionId(),
      branchLeafBeforeRun: ctx.sessionManager.getLeafId(),
      cwd: ctx.cwd,
      startedAt: Date.now(),
      messages: [{ text: event.prompt, imageCount: event.images?.length ?? 0 }],
      calls: [],
      responses: [],
    };
  });

  pi.on("turn_start", (event) => { turnIndex = event.turnIndex; });

  pi.on("message_end", (event) => {
    if (!current) return;
    const message = event.message;
    if (message.role === "user") {
      const content = textContent(message.content);
      // The initial prompt is also delivered as a user message by the agent.
      if (current.calls.length === 0 && current.responses.length === 0 &&
          current.messages.length === 1 && content.text === current.messages[0].text) return;
      current.messages.push({ text: content.text, imageCount: content.nonTextCount });
    } else if (message.role === "assistant") {
      current.responses.push({
        turnIndex,
        text: textContent(message.content).text,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
      });
    }
  });

  pi.on("tool_execution_start", (event) => {
    if (!current) return;
    const args = event.args;
    current.calls.push({
      toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId,
      toolName: event.toolName,
      turnIndex,
      triggerMessageIndex: current.messages.length - 1,
      arguments: structuredClone(args),
      query: typeof args?.query === "string" ? args.query : typeof args?.pattern === "string" ? args.pattern : undefined,
      startedAt: Date.now(),
      status: "unfinished",
    });
  });

  pi.on("tool_execution_end", (event) => {
    const call = current?.calls.find((item) => item.toolCallId === event.toolCallId);
    if (!call) return;
    const result = textContent(event.result?.content);
    call.resultText = result.text;
    call.nonTextResultCount = result.nonTextCount;
    call.status = event.isError ? "error" : "returned";
    call.durationMs = Date.now() - call.startedAt;
  });

  pi.on("agent_end", () => { finish("agent_end"); });
  pi.on("session_shutdown", () => { finish("session_shutdown"); });
}
