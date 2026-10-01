/**
 * Capture tool availability, assistant responses, provider events, and tool execution
 * for diagnosing why a model did or did not call a tool.
 *
 * Usage: /debug-toolcalls [on|off|status]
 * Captures are persisted as expandable transcript entries. Provider events may
 * contain provider response data; enable only when appropriate.
 */

import { type ExtensionAPI, keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { registerToolEffectiveness } from "../support/tool-effectiveness.ts";

const ENTRY_TYPE = "debug-toolcalls";
const STATUS_KEY = "debug-toolcalls";

interface ToolCallDebugEntry {
  toolsAtTurnStart: {
    active: string[];
    registered: Array<{ name: string; exposure?: string; namespace?: unknown }>;
  };
  assistantMessages: unknown[];
  providerEvents: unknown[];
  executions: Array<{
    event: "start" | "end";
    toolCallId: string;
    toolName: string;
    args?: unknown;
    result?: unknown;
    isError?: boolean;
    parentToolCallId?: string;
  }>;
}

export default function debugToolcalls(pi: ExtensionAPI): void {
  registerToolEffectiveness(pi);
  let enabled = false;
  let current: ToolCallDebugEntry | undefined;

  pi.registerEntryRenderer<ToolCallDebugEntry>(ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return new Text(theme.fg("warning", "[tool-call debug] Missing data"), 0, 0);

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const active = data.toolsAtTurnStart.active;
    const registered = data.toolsAtTurnStart.registered.map((tool) => tool.name);
    const target = "zig-stdlib-search";
    const availability = active.includes(target)
      ? `${target}: active`
      : registered.includes(target)
        ? `${target}: registered, not active`
        : `${target}: not registered`;
    const started = data.executions.filter((item) => item.event === "start");
    const lines = [
      `${theme.fg("accent", "[tool-call debug]")} ${availability}`,
      `Active tools: ${active.length} · executions: ${started.length} · provider events: ${data.providerEvents.length}`,
    ];

    for (const message of data.assistantMessages) {
      if (!message || typeof message !== "object") continue;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const item = part as { type?: unknown; name?: unknown; text?: unknown };
        if (item.type === "toolCall") {
          lines.push(`Model requested: ${String(item.name ?? "(unnamed tool)")}`);
        } else if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
          const text = item.text.trim().replace(/\s+/g, " ");
          lines.push(`Model replied: ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
        }
      }
    }
    for (const item of started) lines.push(`Executed: ${item.toolName}`);

    box.addChild(new Text(lines.join("\n"), 0, 0));
    if (!expanded) box.addChild(new Text(keyHint("app.tools.expand", "to inspect summary"), 0, 0));
    return box;
  });

  pi.registerCommand("debug-toolcalls", {
    description: "Capture tool availability and model/tool-call diagnostics",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(requested)) {
        ctx.ui.notify("Usage: /debug-toolcalls [on|off|status]", "warning");
        return;
      }
      if (requested === "status") {
        ctx.ui.notify(`Tool-call diagnostics ${enabled ? "enabled" : "disabled"}`, "info");
        return;
      }
      enabled = requested === "" ? !enabled : requested === "on";
      if (!enabled) current = undefined;
      ctx.ui.setStatus(STATUS_KEY, enabled ? "tool-call debug" : undefined);
      ctx.ui.notify(`Tool-call diagnostics ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("turn_start", () => {
    if (!enabled) {
      current = undefined;
      return;
    }
    const registered = pi.getAllTools();
    current = {
      toolsAtTurnStart: {
        active: pi.getActiveTools(),
        registered: registered.map((tool) => ({
          name: tool.name,
          exposure: tool.exposure,
          namespace: tool.namespace,
        })),
      },
      assistantMessages: [],
      providerEvents: [],
      executions: [],
    };
  });

  pi.on("message_end", (event) => {
    if (current && event.message.role === "assistant") {
      current.assistantMessages.push(structuredClone(event.message));
    }
  });

  pi.on("provider_stream_event", (event) => {
    if (current) current.providerEvents.push(structuredClone(event.data));
  });

  pi.on("tool_execution_start", (event) => {
    current?.executions.push({
      event: "start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: structuredClone(event.args),
      parentToolCallId: event.parentToolCallId,
    });
  });

  pi.on("tool_execution_end", (event) => {
    current?.executions.push({
      event: "end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: structuredClone(event.result),
      isError: event.isError,
      parentToolCallId: event.parentToolCallId,
    });
  });

  pi.on("turn_end", () => {
    if (!current) return;
    pi.appendEntry<ToolCallDebugEntry>(ENTRY_TYPE, current);
    current = undefined;
  });
}
