import { copyToClipboard, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionUIContext, type RegisteredCommand, type SessionMessageEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import copyRangeExtension from "../extensions/copy-range.ts";

// The OS clipboard is the only external side effect; exercise real session storage and picker input.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
	copyToClipboard: vi.fn(async () => {}),
}));

beforeEach(() => { vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined); });

const enter = "\r";
const escape = "\x1b";
const clear = "\x15";
const timestamp = 1_700_000_000_000;
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function user(session: SessionManager, content: string): string {
	return session.appendMessage({ role: "user", content, timestamp });
}

function assistant(session: SessionManager, content: Extract<SessionMessageEntry["message"], { role: "assistant" }>["content"]): string {
	return session.appendMessage({ role: "assistant", content, timestamp, api: "anthropic-messages", provider: "anthropic", model: "test-model", usage, stopReason: "toolUse" });
}

type Picker = Component & Focusable;
type Script = string[] | ((picker: Picker) => void);

function command(session: SessionManager, scripts: Script[] = [], mode: ExtensionCommandContext["mode"] = "tui") {
	let handler: RegisteredCommand["handler"];
	const registerCommand = vi.fn((_name: string, definition: Omit<RegisteredCommand, "name" | "sourceInfo">) => { handler = definition.handler; });
	copyRangeExtension({ registerCommand } as unknown as ExtensionAPI);
	const notify = vi.fn();
	let dialog = 0;
	const custom = vi.fn(async (factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
		let finished = false;
		let result: unknown;
		const picker = await factory(
			{ requestRender: () => {} } as Parameters<typeof factory>[0],
			{ fg: (_color: string, text: string) => text } as Theme,
			getKeybindings() as Parameters<typeof factory>[2],
			(value) => { finished = true; result = value; },
		) as Picker;
		picker.focused = true;
		expect(picker.render(100).join("\n")).toContain(CURSOR_MARKER);
		const script = scripts[dialog++];
		if (typeof script === "function") script(picker);
		else for (const key of script ?? []) picker.handleInput!(key);
		expect(finished, "picker script must select or cancel").toBe(true);
		return result;
	});
	const ctx = { mode, sessionManager: session, ui: { notify, custom } } as unknown as ExtensionCommandContext;
	return { invoke: (args = "") => handler(args, ctx), notify, custom, registerCommand };
}

function copied(): string {
	expect(copyToClipboard).toHaveBeenCalledOnce();
	return vi.mocked(copyToClipboard).mock.calls[0][0];
}

describe("/copy-range", () => {
	it("copies only the inclusive active-branch range, preserving raw history and tool behavior", async () => {
		const session = SessionManager.inMemory();
		user(session, "Outside before");
		const start = user(session, "Investigate this failure");
		const call = assistant(session, [
			{ type: "thinking", thinking: "Check the file first", thinkingSignature: "opaque-secret" },
			{ type: "text", text: "Reading now", textSignature: "opaque-text" },
			{ type: "toolCall", name: "read", namespace: "functions", id: "call-42", arguments: { path: "/tmp/example", offset: 1 } },
		]);
		const output = `Failure details\n${"line of output\n".repeat(1000)}deep-search-marker\n\`\`\`\`\`\n## fake heading`;
		const result = session.appendMessage({
			role: "toolResult", toolName: "read", toolCallId: "call-42", isError: true,
			content: [{ type: "text", text: output }], details: { fullOutputPath: "/tmp/full-output" }, timestamp,
		});
		session.appendContextEdit(call, { content: "Rewritten context, not original behavior" });
		session.appendCompaction("Summary only", result, 9000);
		const leaf = user(session, "Outside after");
		session.branch(start);
		user(session, "Unrelated abandoned branch");
		session.branch(leaf);
		const before = JSON.stringify(session.getEntries());
		const c = command(session, [["investigate this", enter], ["toolresult deep-search-marker", enter]]);
		await c.invoke();

		const transcript = copied();
		expect(transcript).toContain("messages #2–#4 (inclusive)");
		expect(transcript.match(/^## #\d+ .+$/gm)).toEqual([
			expect.stringContaining(`user [${start}]`),
			expect.stringContaining(`assistant [${call}]`),
			expect.stringContaining(`toolResult [${result}]`),
		]);
		expect(transcript).toContain("Check the file first");
		expect(transcript).toContain("Reading now");
		expect(transcript).toContain("Tool call: functions.read [call-42]");
		expect(transcript).toContain('"path": "/tmp/example"');
		expect(transcript).toContain('"offset": 1');
		expect(transcript).toContain('"toolCallId": "call-42"');
		expect(transcript).toContain('"isError": true');
		expect(transcript).toContain('"fullOutputPath": "/tmp/full-output"');
		expect(transcript).toContain(`\`\`\`\`\`\`text\n${output}\n\`\`\`\`\`\``);
		for (const excluded of ["Outside before", "Outside after", "Unrelated abandoned", "Rewritten context", "Summary only", "opaque-secret", "opaque-text"]) {
			expect(transcript).not.toContain(excluded);
		}
		expect(JSON.stringify(session.getEntries())).toBe(before);
		expect(session.getLeafId()).toBe(leaf);
		expect(c.notify).toHaveBeenCalledWith("Copied 3 messages (#2–#4) to clipboard", "info");
	});

	it("defaults to a single message rather than the whole session", async () => {
		const session = SessionManager.inMemory();
		user(session, "First message");
		user(session, "Second message");
		const c = command(session, [[enter], [enter]]);
		await c.invoke();
		expect(copied()).toContain("First message");
		expect(copied()).not.toContain("Second message");
		expect(c.notify).toHaveBeenCalledWith("Copied 1 message (#1–#1) to clipboard", "info");
	});

	it("supports arrow selection and preserves interleaved calls and multiple results in recorded order", async () => {
		const session = SessionManager.inMemory();
		user(session, "Not selected");
		assistant(session, [
			{ type: "text", text: "Before calls" },
			{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
			{ type: "text", text: "Between calls" },
			{ type: "toolCall", id: "call-b", name: "read", arguments: { path: "b" } },
		]);
		for (const id of ["call-b", "call-a"]) session.appendMessage({
			role: "toolResult", toolName: "read", toolCallId: id, isError: false,
			content: [{ type: "text", text: `Result of ${id}` }], timestamp,
		});
		const down = "\x1b[B";
		const c = command(session, [[down, enter], [down, down, enter]]);
		await c.invoke();
		const transcript = copied();
		const parts = ["Before calls", "Tool call: read [call-a]", "Between calls", "Tool call: read [call-b]", "Result of call-b", "Result of call-a"];
		const positions = parts.map((part) => transcript.indexOf(part));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(transcript).not.toContain("Not selected");
	});

	it("distinguishes duplicate messages by ID and does not permit an end before the start", async () => {
		const session = SessionManager.inMemory();
		const first = user(session, "Same text");
		const second = user(session, "Same text");
		user(session, "Later");
		const c = command(session, [[second, enter], (picker) => {
			picker.handleInput!(first);
			expect(picker.render(100).join("\n")).toContain("No matching messages");
			picker.handleInput!(enter); // No match must not silently copy anything.
			picker.handleInput!(clear);
			picker.handleInput!(enter);
		}]);
		await c.invoke();
		expect(copied()).toContain(`user [${second}]`);
		expect(copied()).not.toContain(first);
		expect(copied()).not.toContain("Later");
	});

	it("searches deep content quickly in a long session and respects visible terminal width", async () => {
		const session = SessionManager.inMemory();
		for (let i = 0; i < 1000; i++) user(session, `Message ${i}`);
		const target = user(session, `${"prefix ".repeat(500)}唯一 target 🧪`);
		const c = command(session, [(picker) => {
			picker.handleInput!("唯一 target");
			for (const width of [1, 20, 80]) {
				for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			picker.handleInput!(enter);
		}, [enter]]);
		await c.invoke();
		expect(copied()).toContain(target);
		expect(copied()).toContain("唯一 target 🧪");
		expect(copied()).not.toContain("Message 999");
	});

	it("includes system changes, custom messages, bash executions and recorded summary roles", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "system", content: "", sections: { preamble: "System instructions" }, toolsRemoved: [{ name: "write" }], timestamp });
		const first = user(session, "Starting");
		session.appendCustomMessageEntry("checkpoint", "Custom context", false, { useful: true });
		session.appendMessage({ role: "bashExecution", command: "echo hello", output: "hello\n", exitCode: 0, cancelled: false, truncated: false, timestamp });
		session.appendCompaction("Compaction context", first, 1000);
		session.branchWithSummary(session.getLeafId(), "Branch context");
		user(session, "Finish here");
		const c = command(session, [[enter], ["finish here", enter]]);
		await c.invoke();
		const transcript = copied();
		expect(transcript.match(/^## .+$/gm)?.map((line) => line.split(" ")[2])).toEqual([
			"system", "user", "custom", "bashExecution", "compactionSummary", "branchSummary", "user",
		]);
		for (const included of ["System instructions", '"toolsRemoved"', "Custom context", '"display": false', "echo hello", "hello\n", '"exitCode": 0', "Compaction context", "Branch context", "Finish here"]) {
			expect(transcript).toContain(included);
		}
	});

	it("preserves image-only, redacted thinking, empty and failed assistant messages without copying image blobs", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "IMAGE_BLOB" }], timestamp });
		assistant(session, [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "OPAQUE_SIGNATURE" }]);
		session.appendMessage({ role: "assistant", content: [], timestamp, api: "anthropic-messages", provider: "anthropic", model: "test-model", usage, stopReason: "error", errorMessage: "Provider failed" });
		const c = command(session, [[enter], ["provider failed", enter]]);
		await c.invoke();
		const transcript = copied();
		expect(transcript).toContain("[Image: image/png; base64 data omitted]");
		expect(transcript).toContain("Thinking (redacted)");
		expect(transcript).toContain('"stopReason": "error"');
		expect(transcript).toContain("Provider failed");
		expect(transcript).not.toContain("IMAGE_BLOB");
		expect(transcript).not.toContain("OPAQUE_SIGNATURE");
	});

	it.each([{ scripts: [[escape]] }, { scripts: [[enter], [escape]] }])("cancelling either picker leaves the clipboard unchanged (%j)", async ({ scripts }) => {
		const session = SessionManager.inMemory();
		user(session, "A message");
		const c = command(session, scripts);
		await c.invoke();
		expect(copyToClipboard).not.toHaveBeenCalled();
		expect(c.notify).not.toHaveBeenCalled();
	});

	it("allows cancellation when a search has no matches", async () => {
		const session = SessionManager.inMemory();
		user(session, "A message");
		const c = command(session, [["does-not-exist", escape]]);
		await c.invoke();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it("notifies for a branch without messages rather than copying state entries", async () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry("state", { value: "not a message" });
		const c = command(session);
		await c.invoke();
		expect(c.notify).toHaveBeenCalledWith("No messages on the active branch to copy", "warning");
		expect(c.custom).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it.each([new Error("Clipboard unavailable: install wl-clipboard"), "permission denied"])("reports clipboard failures clearly: %s", async (failure) => {
		const session = SessionManager.inMemory();
		user(session, "A message");
		vi.mocked(copyToClipboard).mockRejectedValue(failure);
		const c = command(session, [[enter], [enter]]);
		await c.invoke();
		expect(c.notify).toHaveBeenCalledOnce();
		expect(c.notify).toHaveBeenCalledWith(`Could not copy range: ${failure instanceof Error ? failure.message : failure}`, "error");
	});

	it.each(["rpc", "json", "print"] as const)("rejects %s mode without opening terminal UI or copying", async (mode) => {
		const c = command(SessionManager.inMemory(), [], mode);
		await c.invoke();
		expect(c.notify).toHaveBeenCalledWith(expect.stringContaining("requires TUI mode"), "error");
		expect(c.custom).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});

	it("registers the command and rejects unexpected arguments", async () => {
		const c = command(SessionManager.inMemory());
		await c.invoke("all");
		expect(c.registerCommand).toHaveBeenCalledWith("copy-range", expect.objectContaining({ description: expect.stringContaining("active branch") }));
		expect(c.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /copy-range"), "warning");
		expect(c.custom).not.toHaveBeenCalled();
		expect(copyToClipboard).not.toHaveBeenCalled();
	});
});
