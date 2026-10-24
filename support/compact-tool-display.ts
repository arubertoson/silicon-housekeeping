import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  mixColors,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface CallDescription {
  text: string;
  isPath?: boolean;
}

export interface ToolOutcome {
  summary: string;
  detail?: string;
  additions?: number;
  removals?: number;
}

export type ToolStatus = "preparing" | "running" | "done" | "failed";

const STATUS_STYLES = {
  preparing: { color: "muted", symbol: "·", label: "preparing" },
  running: { color: "warning", symbol: "›", label: "running" },
  done: { color: "success", symbol: "✓", label: "done" },
  failed: { color: "error", symbol: "✗", label: "failed" },
} as const;

export function cleanText(text: string): string {
  return stripTerminalSequences(text).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function countLines(text: string): number {
  return text === "" ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

export function summarizeResult(
  toolName: string,
  args: unknown,
  result: AgentToolResult<unknown>,
  isPartial: boolean,
  isError: boolean,
): ToolOutcome {
  const output = stripTerminalSequences(result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n"));
  const lines = output.split(/\r?\n/).map(cleanText).filter(Boolean);

  if (isError) {
    const exit = output.match(/(?:exited with code|exit code:?)\s*(\d+)/i)?.[1];
    const detail = lines.find((line) => /\berror\b|TS\d{4}:|AssertionError|ENOENT|fatal:|\bFAIL\b/i.test(line)) ?? lines[0];
    return { summary: exit ? `exit ${exit}` : "failed", detail };
  }
  if (isPartial) {
    const showOutput = ["bash", "powershell", "codemode", "subagent"].includes(toolName);
    return { summary: "running", detail: showOutput ? lines.at(-1) : undefined };
  }
  if (toolName === "edit") {
    const details = fields(result.details);
    const diff = typeof details.diff === "string" ? details.diff : undefined;
    if (diff) {
      const diffLines = diff.split("\n");
      const additions = diffLines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length;
      const removals = diffLines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length;
      return { summary: `+${additions} −${removals}`, additions, removals };
    }
    return { summary: "applied" };
  }
  if (toolName === "read") {
    if (result.content.some((part) => part.type === "image")) return { summary: "image" };
    return { summary: `${countLines(output)} lines` };
  }
  if (toolName === "write") {
    const content = fields(args).content;
    return { summary: typeof content === "string" ? `${countLines(content)} lines written` : "written" };
  }
  if (toolName === "bash" || toolName === "powershell") {
    const tests = [...output.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1];
    if (tests) return { summary: cleanText(tests).replace(/\s+\(\d+\)$/, "") };
    return { summary: lines.at(-1) ?? "done" };
  }
  return { summary: lines.length > 0 ? `${lines.length} lines` : "done" };
}

function durationLabel(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(durationMs < 10000 ? 2 : 1)}s`;
}

function fitDescription(description: CallDescription, width: number, theme: Theme): string {
  let text = description.text;
  if (description.isPath && visibleWidth(text) > width && width > 1) {
    // Retain the filename when long parent directories cannot fit.
    text = `…${sliceByColumn(text, visibleWidth(text) - width + 1, width - 1)}`;
  }
  if (description.isPath) {
    const slash = text.lastIndexOf("/");
    text = theme.fg("muted", text.slice(0, slash + 1)) + theme.fg("toolTitle", text.slice(slash + 1));
  } else {
    text = theme.fg("toolTitle", text);
  }
  return truncateToWidth(text, Math.max(0, width));
}

interface ActivityStripOptions {
  toolName: string;
  description: CallDescription;
  status: ToolStatus;
  durationMs: number | undefined;
  outputPad: number;
  outcome: () => ToolOutcome | undefined;
}

export function activityStrip(options: ActivityStripOptions, theme: Theme): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const { status } = options;
      const outcome = options.outcome();
      const { color, symbol, label: statusLabel } = STATUS_STYLES[status];
      const background = mixColors(theme.colors.toolPendingBg, theme.colors[color], status === "done" ? 0.025 : 0.10);
      const padding = " ".repeat(Math.min(options.outputPad, Math.floor(width / 2)));
      const contentWidth = Math.max(0, width - padding.length * 2);
      const label = truncateToWidth(cleanText(options.toolName).toUpperCase(), 12);
      const prefix = `${theme.fg(color, symbol)}  ${theme.fg("accent", theme.bold(label.padEnd(8)))} `;
      const prefixWidth = visibleWidth(prefix);
      const summary = outcome?.summary ?? statusLabel;
      const duration = durationLabel(options.durationMs);
      let right = theme.fg(status === "failed" ? "error" : "muted", cleanText(summary));
      if (status === "done" && outcome?.additions !== undefined && outcome.removals !== undefined) {
        right = `${theme.fg("success", `+${outcome.additions}`)} ${theme.fg("error", `−${outcome.removals}`)}`;
      }
      const elapsed = duration ? theme.fg("dim", ` · ${duration}`) : "";
      const rightWidth = Math.max(0, Math.min(
        visibleWidth(right) + visibleWidth(elapsed),
        Math.floor(contentWidth * 0.45),
        contentWidth - prefixWidth - 14,
      ));
      if (rightWidth > visibleWidth(elapsed) + 4) {
        right = truncateToWidth(right, rightWidth - visibleWidth(elapsed)) + elapsed;
      } else {
        right = truncateToWidth(right, rightWidth);
      }
      const gap = rightWidth > 0 ? 2 : 0;
      const targetWidth = Math.max(0, contentWidth - prefixWidth - rightWidth - gap);
      const left = truncateToWidth(prefix + fitDescription(options.description, targetWidth, theme), contentWidth);
      const space = " ".repeat(Math.max(0, contentWidth - visibleWidth(left) - visibleWidth(right)));
      const paint = (text: string): string => {
        const fitted = truncateToWidth(padding + text + padding, width, "", true);
        return theme.style(fitted, { bg: background });
      };
      const rendered = [paint(left + space + right)];
      if (status === "running" || (status === "failed" && outcome?.detail)) {
        const detail = cleanText(outcome?.detail ?? "Waiting for output…");
        const indent = " ".repeat(Math.min(prefixWidth, contentWidth));
        rendered.push(paint(indent + theme.fg(status === "failed" ? "error" : "muted", detail)));
      }
      return rendered;
    },
  };
}
