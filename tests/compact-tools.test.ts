import type { ExtensionAPI, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import compactTools from "../extensions/compact-tools.ts";

import { testTheme } from "./theme-fixture.ts";

const theme = testTheme();
type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    args: {}, toolCallId: "test", invalidate() {}, lastComponent: undefined,
    state: {}, cwd: "/project", executionStarted: false, argsComplete: false,
    isPartial: true, expanded: false, showImages: false, isError: false,
    durationMs: undefined, outputPad: 1, ...overrides,
  };
}

function renderer(toolName: string, original?: ToolRenderers) {
  let resolver: ToolRendererResolver | undefined;
  compactTools({ registerToolRenderer(value: ToolRendererResolver) { resolver = value; } } as ExtensionAPI);
  const result = resolver?.(toolName, () => original);
  if (!result?.renderCall || !result.renderResult) throw new Error("Missing compact renderers");
  return { ...result, renderCall: result.renderCall, renderResult: result.renderResult };
}

function lines(component: { render(width: number): string[] }, width = 100): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line).trim());
}

function compactLine(component: { render(width: number): string[] }, width = 100): string {
  return lines(component, width)[0]!.replace(/\s+/g, " ");
}

function textResult(text: string, details: unknown = undefined) {
  return { content: [{ type: "text" as const, text }], details };
}

const output = textResult("long output\nsecond line");

describe("compact tool transcript", () => {
  it.each([
    ["read", { path: "/project/src/foo.ts" }, "READ src/foo.ts"],
    ["bash", { command: "npm test\n-- --run" }, "BASH npm test"],
    ["bash", { command: "/long/absolute/path/to/tsc --noEmit" }, "BASH tsc --noEmit"],
    ["ffgrep", { pattern: "registerToolRenderer", path: "src/" }, "FFGREP registerToolRenderer"],
    ["codemode", { code: "await tools.bash({command: 'npm test'})" }, "CODEMODE script"],
    ["subagent", { task: "Review tool rendering" }, "SUBAGENT Review tool rendering"],
    ["unknown", {}, "UNKNOWN"],
    ["read", undefined, "READ"],
    ["read", { path: "/elsewhere/foo.ts" }, "READ /elsewhere/foo.ts"],
  ])("shows a compact %s activity strip", (name, args, expected) => {
    const view = renderer(name);
    expect(view.renderShell).toBe("self");
    expect(compactLine(view.renderCall(args, theme, context()))).toBe(`· ${expected} preparing`);
    expect(lines(view.renderResult(output, { expanded: false, isPartial: false }, theme, context()))).toEqual([]);
  });

  it("shows static running state, bounded progress, and a completed test summary in native render order", () => {
    const view = renderer("bash");
    const args = { command: "npm test" };
    const ctx = context({ args, executionStarted: true });
    const call = view.renderCall(args, theme, ctx);
    expect(compactLine(call)).toBe("› BASH npm test running");
    expect(lines(call)[1]).toBe("Waiting for output…");
    view.renderResult(textResult("old output\n\x1b[32mRUN v4.1.11\x1b[0m"), { expanded: false, isPartial: true }, theme, ctx);
    expect(lines(call)[1]).toBe("RUN v4.1.11");

    const done = { ...ctx, isPartial: false, durationMs: 1970 };
    const completedCall = view.renderCall(args, theme, done);
    view.renderResult(textResult("Tests 126 passed (126)\nDuration 1.97s"), { expanded: false, isPartial: false }, theme, done);
    expect(compactLine(completedCall)).toBe("✓ BASH npm test 126 passed · 1.97s");
    expect(lines(completedCall)).toHaveLength(1);
    expect(stripTerminalSequences(completedCall.render(100)[0]!)).toMatch(/126 passed · 1\.97s $/);
  });

  it("summarizes multi-file edits and colored diff counts without invoking native previews", () => {
    const originalCall = vi.fn(() => new Text("unwanted preview"));
    const originalResult = vi.fn(() => new Text("unwanted diff"));
    const view = renderer("edit", { renderCall: originalCall, renderResult: originalResult });
    const args = { text: "[src/one.ts]\n@REPLACE\n-old\n+new\n[src/two.ts]\n@APPEND\n+new\n[src/one.ts]\n@APPEND\n+again" };
    const ctx = context({ args, isPartial: false });
    const call = view.renderCall(args, theme, ctx);
    view.renderResult(textResult("Applied", { diff: "File: src/one.ts\n-1 old\n+1 new\n+2 again\n 3 context" }),
      { expanded: false, isPartial: false }, theme, ctx);
    expect(compactLine(call)).toBe("✓ EDIT src/one.ts (+1 file) +2 −1");
    expect(call.render(100)[0]).toContain(theme.fg("success", "+2"));
    expect(call.render(100)[0]).toContain(theme.fg("error", "−1"));
    expect(originalCall).not.toHaveBeenCalled();
    expect(originalResult).not.toHaveBeenCalled();
  });

  it.each([
    ["read", {}, textResult("one\ntwo\n"), "2 lines"],
    ["write", { content: "one\ntwo" }, textResult("Written"), "2 lines written"],
    ["read", {}, textResult(""), "0 lines"],
    ["bash", {}, textResult(""), "done"],
  ])("shows useful %s results", (name, args, result, expected) => {
    const view = renderer(name);
    const ctx = context({ args, isPartial: false });
    const call = view.renderCall(args, theme, ctx);
    view.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
    expect(compactLine(call)).toContain(expected);
  });

  it("keeps long descriptions, progress, and terminal escapes bounded at narrow widths", () => {
    const view = renderer("bash");
    const args = { command: `\x1b[31mecho ${"界".repeat(100)}\x1b[0m` };
    const ctx = context({ args, executionStarted: true });
    const call = view.renderCall(args, theme, ctx);
    view.renderResult(textResult(`\x1b[31m${"progress ".repeat(100)}\x1b[0m`), { expanded: false, isPartial: true }, theme, ctx);
    for (const width of [0, 1, 4, 12, 25, 100]) {
      const rendered = call.render(width);
      expect(rendered).toHaveLength(width === 0 ? 0 : 2);
      for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(lines(call)[0]).toContain("echo");
    expect(lines(call).join("")).not.toContain("\x1b");
  });

  it("uses available width and preserves the filename when parent directories need truncation", () => {
    const view = renderer("read");
    const call = view.renderCall({ path: `${"directory/".repeat(12)}important.ts` }, theme, context());
    expect(lines(call, 180)[0]).toContain("directory/".repeat(12));
    expect(lines(call, 70)[0]).toContain("important.ts");
  });

  it("uses distinct tinted backgrounds for success, running, and failure in dark and light themes", () => {
    for (const palette of [theme, testTheme("light")]) {
      const view = renderer("bash");
      const backgrounds = [
        context({ isPartial: false }),
        context({ executionStarted: true }),
        context({ isPartial: false, isError: true }),
      ].map((ctx) => {
        const call = view.renderCall({ command: "npm test" }, palette, ctx);
        const rendered = call.render(80)[0]!;
        expect(visibleWidth(rendered)).toBe(80);
        expect(rendered).toContain("\x1b[48;2;");
        call.invalidate();
        expect(call.render(80)[0]).toBe(rendered);
        return rendered.match(/\x1b\[48;2;[\d;]+m/)?.[0];
      });
      expect(new Set(backgrounds).size).toBe(3);
    }
  });

  it("shows the first useful error, rather than hiding it or dumping its stack", () => {
    const view = renderer("bash");
    const args = { command: "tsc --noEmit" };
    const ctx = context({ args, isPartial: false, isError: true });
    const call = view.renderCall(args, theme, ctx);
    const error = textResult("Compiling…\nfoo.ts(1,2): error TS7006: bad parameter\nstack frame\nCommand exited with code 2");
    view.renderResult(error, { expanded: false, isPartial: false }, theme, ctx);
    expect(compactLine(call)).toBe("✗ BASH tsc --noEmit exit 2");
    expect(lines(call)[1]).toBe("foo.ts(1,2): error TS7006: bad parameter");
    expect(lines(call)).toHaveLength(2);
    expect(lines(view.renderResult(error, { expanded: true, isPartial: false }, theme, ctx)).join("\n")).toContain("stack frame");
  });

  it("preserves a self-rendering subagent's live summary and report", () => {
    const originalCall = vi.fn(() => new Text("SUBAGENT Review rendering", 0, 0));
    const originalResult = vi.fn(() => new Text("queued · 0/12 requests", 0, 0));
    const view = renderer("subagent", { renderShell: "self", renderCall: originalCall, renderResult: originalResult });
    const ctx = context();
    expect(lines(view.renderCall({}, theme, ctx))).toEqual(["SUBAGENT Review rendering"]);
    expect(lines(view.renderResult(output, { expanded: false, isPartial: true }, theme, ctx)))
      .toEqual(["queued · 0/12 requests"]);
  });

  it("delegates expanded details and keeps original component reuse isolated per call and slot", () => {
    const originalCall = vi.fn((_args, _theme, ctx: RenderContext) => ctx.lastComponent ?? new Container());
    const originalResult = vi.fn((_result, _options, _theme, ctx: RenderContext) => ctx.lastComponent ?? new Container());
    const view = renderer("edit", { renderCall: originalCall, renderResult: originalResult });
    const ctx = context({ expanded: true });
    const call = view.renderCall({}, theme, ctx);
    const result = view.renderResult(output, { expanded: true, isPartial: false }, theme, ctx);
    const compact = view.renderCall({ path: "foo.ts" }, theme, { ...ctx, expanded: false, lastComponent: call });
    expect(view.renderCall({}, theme, { ...ctx, lastComponent: compact })).toBe(call);
    expect(view.renderResult(output, { expanded: true, isPartial: false }, theme, ctx)).toBe(result);
    expect(originalCall.mock.calls[0]![2].lastComponent).toBeUndefined();
    expect(originalCall.mock.calls[1]![2].lastComponent).toBe(call);
    expect(originalResult.mock.calls[1]![3].lastComponent).toBe(result);
    expect(view.renderCall({}, theme, context({ expanded: true }))).not.toBe(call);
  });

  it("falls back to full arguments and text for tools without native renderers", () => {
    const view = renderer("unknown");
    const rendered = lines(view.renderCall({ query: "all details" }, theme, context({ expanded: true })));
    expect(rendered.join("\n")).toContain('"query": "all details"');
  });
});
