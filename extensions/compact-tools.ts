import { isAbsolute, relative } from "node:path";
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import {
  activityStrip,
  type CallDescription,
  cleanText,
  summarizeResult,
  type ToolOutcome,
  type ToolStatus,
} from "../support/compact-tool-display.ts";

interface RendererState {
  call?: Component;
  result?: Component;
  outcome?: ToolOutcome;
}

function shortPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const local = relative(cwd, path);
  return local && local !== ".." && !local.startsWith("../") ? local : path;
}

function describeCall(toolName: string, args: unknown, cwd: string): CallDescription {
  if (!args || typeof args !== "object") return { text: "" };
  const fields = args as Record<string, unknown>;

  // Unified edit accepts a row script instead of a path. Summarize the whole
  // batch, without starting the original renderer's asynchronous diff previews.
  if (toolName === "edit" && typeof fields.text === "string") {
    const files = [...new Set([...fields.text.matchAll(/^\[([^\r\n]+)\]\r?$/gm)].map((match) => match[1]!))];
    if (files.length > 0) {
      const extra = files.length > 1 ? ` (+${files.length - 1} ${files.length === 2 ? "file" : "files"})` : "";
      return { text: `${cleanText(shortPath(files[0]!, cwd))}${extra}`, isPath: true };
    }
  }

  if (toolName === "codemode") return { text: "script" };
  for (const key of ["command", "pattern", "query", "path", "url", "action", "title", "task", "prompt", "objective"]) {
    const value = fields[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (key === "path") return { text: cleanText(shortPath(value, cwd)), isPath: true };
    if (key === "command") {
      // A heredoc's program body is not a useful command label. Also shorten
      // absolute executable paths, without changing the displayed arguments.
      const command = value.split(/\r?\n/, 1)[0] ?? "";
      return { text: cleanText(command).replace(/^\/\S+\/([^/\s]+)(?=\s|$)/, "$1") };
    }
    return { text: cleanText(value) };
  }
  return { text: "" };
}

export default function compactTools(pi: ExtensionAPI): void {
  pi.registerToolRenderer((toolName, next): ToolRenderers => {
    const original = next();
    // The internal subagent already owns a bounded summary and expanded report.
    if (toolName === "subagent" && original?.renderShell === "self") return original;
    // The original renderers retain their own components. Our compact header
    // reads the outcome after renderResult updates it in the same display pass.
    const states = new WeakMap<object, RendererState>();
    const stateFor = (key: object): RendererState => {
      let state = states.get(key);
      if (!state) {
        state = {};
        states.set(key, state);
      }
      return state;
    };

    return {
      renderShell: "self",
      renderCall(args, theme, context) {
        const state = stateFor(context.state);
        if (context.expanded) {
          if (original?.renderCall) {
            state.call = original.renderCall(args, theme, { ...context, lastComponent: state.call });
            return state.call;
          }
          return new Text(`${toolName}\n${JSON.stringify(args, null, 2) ?? ""}`, context.outputPad, 0);
        }

        let status: ToolStatus = "preparing";
        if (!context.isPartial) status = context.isError ? "failed" : "done";
        else if (context.executionStarted) status = "running";
        return activityStrip({
          toolName,
          description: describeCall(toolName, args, context.cwd),
          status,
          durationMs: context.durationMs,
          outputPad: context.outputPad,
          outcome: () => state.outcome,
        }, theme);
      },
      renderResult(result, options, theme, context) {
        const state = stateFor(context.state);
        state.outcome = summarizeResult(toolName, context.args, result, options.isPartial, context.isError);
        if (!options.expanded) return new Container();
        if (original?.renderResult) {
          state.result = original.renderResult(result, options, theme, { ...context, lastComponent: state.result });
          return state.result;
        }
        const output = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        return new Text(theme.fg(context.isError ? "error" : "toolOutput", output), context.outputPad, 0);
      },
    };
  });
}
