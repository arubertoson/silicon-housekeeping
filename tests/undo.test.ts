import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	ModelRuntime, SessionManager, SettingsManager,
	type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import undoExtension from "../extensions/undo.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function user(session: SessionManager, content: string): string {
	return session.appendMessage({ role: "user", content, timestamp: Date.now() });
}
function answer(session: SessionManager, text = "Earlier answer"): string {
	return session.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "undo-test", model: "local", usage, stopReason: "stop", timestamp: Date.now() });
}

async function harness(options: {
	seed?: (manager: SessionManager) => void;
	extra?: (pi: ExtensionAPI) => void;
	mode?: "tui" | "rpc" | "print";
	inMemory?: boolean;
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-undo-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "test-template.md"), "Expanded $1");
	const requests: { messages: { role: string; content: unknown }[] }[] = [];
	let hold: "before-text" | "after-text" | undefined;
	let received: (() => void) | undefined;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push(JSON.parse(body));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.flushHeaders();
		const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		if (hold !== "before-text") chunk({ role: "assistant", content: "Local answer" });
		received?.();
		if (!hold) {
			chunk({}, "stop");
			res.end("data: [DONE]\n\n");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	const port = (server.address() as { port: number }).port;
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
	modelRuntime.registerProvider("undo-test", {
		baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "offline-test", api: "openai-completions",
		models: [{ id: "local", name: "Offline local model", reasoning: false, input: ["text", "image"], contextWindow: 100_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	const model = modelRuntime.getModel("undo-test", "local")!;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, defaultProvider: "undo-test", defaultModel: "local" });
	const manager = options.inMemory ? SessionManager.inMemory(root) : SessionManager.create(root, join(root, "sessions"));
	if (options.seed) {
		manager.appendModelChange("undo-test", "local");
		manager.appendThinkingLevelChange("off");
	}
	options.seed?.(manager);
	let editor = "";
	const notices: { message: string; type: string | undefined }[] = [];
	const errors: string[] = [];
	const ui = {
		notify: (message: string, type?: string) => notices.push({ message, type }),
		getEditorText: () => editor,
		setEditorText: (text: string) => { editor = text; },
	} as unknown as ExtensionUIContext;
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd, agentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				extensionFactories: [undoExtension, ...(options.extra ? [options.extra] : [])],
				additionalPromptTemplatePaths: [join(root, "test-template.md")],
			},
		});
		return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: "all" }), services, diagnostics: [] };
	};
	const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir: root, sessionManager: manager });
	cleanup.push(() => runtime.dispose());
	const bind = async () => {
		await runtime.session.bindExtensions({
			mode: options.mode ?? "tui", uiContext: ui,
			commandContextActions: {
				waitForIdle: () => runtime.session.waitForIdle(),
				switchSession: (path, opts) => runtime.switchSession(path, opts),
				newSession: (opts) => runtime.newSession(opts),
				fork: (id, opts) => runtime.fork(id, opts),
				navigateTree: async () => ({ cancelled: true }), reload: async () => {},
			},
			onError: (error) => errors.push(error.error),
		});
	};
	runtime.setRebindSession(bind);
	await bind();
	return {
		root, runtime, manager, requests, notices, errors,
		editor: () => editor, setEditor: (text: string) => { editor = text; },
		undo: () => runtime.session.prompt("/undo"),
		holdNext: (stage: NonNullable<typeof hold>) => { hold = stage; return new Promise<void>((resolve) => { received = resolve; }); },
		releaseNext: () => { hold = undefined; received = undefined; },
	};
}

function disk(runtime: AgentSessionRuntime): SessionManager {
	return SessionManager.open(runtime.session.sessionFile!);
}
function assertNoUndoArtifacts(root: string) {
	expect(readdirSync(join(root, "sessions")).filter((file) => !file.endsWith(".jsonl"))).toEqual([]);
}

describe("/undo through Pi's real session runtime and offline HTTP provider", () => {
	it("deletes a completed turn, restores the submitted template, and resends from the same session without a branch", async () => {
		const h = await harness({ seed: (manager) => { user(manager, "Earlier prompt"); answer(manager); } });
		const path = h.runtime.session.sessionFile;
		const id = h.runtime.session.sessionId;
		const before = h.runtime.session.sessionManager.getBranch();
		await h.runtime.session.prompt("/test-template original 🧪\nsecond line");
		expect(h.runtime.session.getLastAssistantText()).toBe("Local answer");
		const removed = h.runtime.session.sessionManager.getBranch().slice(before.length).filter((entry) => entry.type === "message" && entry.message.role !== "system").map((entry) => entry.id);
		await h.undo();
		expect(h.errors).toEqual([]);
		expect(h.editor()).toBe("/test-template original 🧪\nsecond line");
		expect(h.runtime.session.sessionFile).toBe(path);
		expect(h.runtime.session.sessionId).toBe(id);
		for (const entryId of removed) expect(disk(h.runtime).getEntry(entryId)).toBeUndefined();
		expect(disk(h.runtime).getEntries()).toEqual(before);
		expect(h.runtime.session.messages.filter((message) => message.role !== "system")).toEqual(before.filter((entry) => entry.type === "message").map((entry) => entry.message));
		h.setEditor("");
		await h.runtime.session.prompt("Edited retry");
		expect(h.requests.at(-1)!.messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : (message.content as { text: string }[]).map((block) => block.text).join("\n"))).toEqual(["Earlier prompt", "Edited retry"]);
		expect(disk(h.runtime).getTree().flatMap(function flatten(node): typeof node[] { return [node, ...node.children.flatMap(flatten)]; }).every((node) => node.children.length <= 1)).toBe(true);
		expect(readdirSync(join(h.root, "sessions"))).toEqual([path!.split("/").at(-1)]);
		assertNoUndoArtifacts(h.root);
	});

	it.each(["completed", "active", "draft"] as const)("Alt+U dispatches undo for a %s turn without submitting another prompt", async (stage) => {
		const h = await harness({ seed: (manager) => { user(manager, "Base"); answer(manager); } });
		const before = h.runtime.session.sessionManager.getEntries();
		const path = h.runtime.session.sessionFile;
		const received = stage === "active" ? h.holdNext("before-text") : undefined;
		const response = h.runtime.session.prompt("Mistaken prompt");
		if (received) await received;
		else await response;
		const submitted = h.runtime.session.sessionManager.getEntries();
		if (stage === "draft") h.setEditor("Keep my draft");
		const runner = h.runtime.session.extensionRunner;
		const shortcut = runner.getShortcuts({}).get("alt+u");
		expect(shortcut).toBeDefined();
		await shortcut!.handler(runner.createContext());
		await expect.poll(() => h.notices.at(-1)?.message).toContain(stage === "draft" ? "editor draft" : "prompt restored");
		await response;
		expect(h.editor()).toBe(stage === "draft" ? "Keep my draft" : "Mistaken prompt");
		expect(disk(h.runtime).getEntries()).toEqual(stage === "draft" ? submitted : before);
		expect(h.runtime.session.sessionFile).toBe(path);
		expect(h.requests).toHaveLength(1);
		expect(h.errors).toEqual([]);
		assertNoUndoArtifacts(h.root);
	});

	it("restores the exact pre-submit tree for a new session, including removing its initial system declaration", async () => {
		const h = await harness();
		const before = h.runtime.session.sessionManager.getEntries();
		await h.runtime.session.prompt("First real prompt");
		await h.undo();
		expect(h.notices.at(-1)?.type).toBe("info");
		expect(disk(h.runtime).getEntries()).toEqual(before);
		expect(h.runtime.session.messages).toEqual([]);
		expect(h.editor()).toBe("First real prompt");
		h.setEditor("");
		await h.runtime.session.prompt("First corrected prompt");
		expect(JSON.stringify(h.requests.at(-1))).not.toContain("First real prompt");
		expect(h.errors).toEqual([]);
	});

	it.each(["before-text", "after-text"] as const)("stops an active response %s and removes its aborted output before an edited retry", async (stage) => {
		const h = await harness({ seed: (manager) => { user(manager, "Base"); answer(manager); } });
		const received = h.holdNext(stage);
		let streamed: (() => void) | undefined;
		const text = new Promise<void>((resolve) => { streamed = resolve; });
		h.runtime.session.subscribe((event) => { if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") streamed?.(); });
		const outgoing = h.runtime.session;
		const response = outgoing.prompt("Mistaken prompt");
		await received;
		if (stage === "after-text") await text;
		expect(outgoing.isIdle).toBe(false);
		await h.undo();
		await response;
		expect(outgoing.sessionManager.getEntries()).toContainEqual(expect.objectContaining({ type: "message", message: expect.objectContaining({ role: "assistant", stopReason: "aborted" }) }));
		expect(h.editor()).toBe("Mistaken prompt");
		expect(h.runtime.session.isIdle).toBe(true);
		expect(disk(h.runtime).getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted")).toBe(false);
		h.releaseNext(); h.setEditor("");
		await h.runtime.session.prompt("Corrected prompt");
		expect(JSON.stringify(h.requests.at(-1))).not.toContain("Mistaken prompt");
		expect(h.errors).toEqual([]);
		assertNoUndoArtifacts(h.root);
	});

	it("preserves unrelated branches and the pre-turn compaction, but removes tools, context edits and later compaction", async () => {
		let base: string, sibling: string, target: string, otherDescendant: string;
		const h = await harness({ seed: (manager) => {
			const first = user(manager, "Base"); answer(manager);
			base = manager.appendCompaction("Earlier summary", first, 100);
			sibling = user(manager, "Unrelated branch"); answer(manager, "Sibling answer");
			manager.branch(base);
			target = user(manager, "Remove me");
			const call = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "example" } }], api: "openai-completions", provider: "undo-test", model: "local", usage, stopReason: "toolUse", timestamp: Date.now() });
			manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "write", content: [{ type: "text", text: "Changed file" }], isError: false, timestamp: Date.now() });
			manager.appendContextEdit(call, null);
			manager.appendCompaction("Remove this summary", target, 200);
			const leaf = manager.getLeafId()!;
			manager.branch(target);
			otherDescendant = user(manager, "Dependent alternative");
			manager.branch(leaf);
		} });
		const expected = h.manager.getBranch(base!).map((entry) => entry.id);
		const changedFile = join(h.root, "example"); writeFileSync(changedFile, "Already changed");
		await h.undo();
		const restored = disk(h.runtime);
		expect(restored.getBranch().map((entry) => entry.id)).toEqual(expected);
		expect(restored.getEntry(sibling!)).toBeDefined();
		expect(restored.getEntry(target!)).toBeUndefined();
		expect(restored.getEntry(otherDescendant!)).toBeUndefined();
		expect(restored.getEntries().filter((entry) => entry.type === "compaction").map((entry) => entry.summary)).toEqual(["Earlier summary"]);
		expect(readFileSync(changedFile, "utf8")).toBe("Already changed");
		expect(h.editor()).toBe("Remove me");
		expect(h.errors).toEqual([]);
	});

	it("does not resurrect records appended by outgoing shutdown hooks", async () => {
		const h = await harness({ seed: (manager) => { user(manager, "Base"); answer(manager); user(manager, "Remove"); answer(manager); }, extra: (pi) => {
			pi.on("session_shutdown", () => pi.appendEntry("shutdown-note", { gone: true }));
		} });
		await h.undo();
		expect(disk(h.runtime).getEntries().some((entry) => entry.type === "custom" && entry.customType === "shutdown-note")).toBe(false);
		expect(h.runtime.session.sessionManager.getEntries()).toEqual(disk(h.runtime).getEntries());
		expect(h.errors).toEqual([]);
	});

	it("cancelling the session switch leaves the file, tree and editor unchanged", async () => {
		const h = await harness({ seed: (manager) => { user(manager, "Keep"); answer(manager); }, extra: (pi) => { pi.on("session_before_switch", () => ({ cancel: true })); } });
		const before = readFileSync(h.runtime.session.sessionFile!, "utf8");
		const old = h.runtime.session;
		await h.undo();
		expect(h.runtime.session).toBe(old);
		expect(readFileSync(old.sessionFile!, "utf8")).toBe(before);
		expect(h.editor()).toBe("");
		expect(h.notices.at(-1)?.message).toContain("cancelled");
		assertNoUndoArtifacts(h.root);
	});

	it("retains before-switch hook writes when the switch is cancelled", async () => {
		const h = await harness({ seed: (manager) => { user(manager, "Keep"); answer(manager); }, extra: (pi) => {
			pi.on("session_before_switch", () => { pi.appendEntry("cancel-note", { kept: true }); return { cancel: true }; });
		} });
		const before = h.runtime.session.sessionManager.getEntries();
		await h.undo();
		expect(h.editor()).toBe("");
		expect(disk(h.runtime).getEntries().slice(0, before.length)).toEqual(before);
		expect(disk(h.runtime).getEntries().at(-1)).toMatchObject({ type: "custom", customType: "cancel-note" });
		expect(disk(h.runtime).getEntries()).toEqual(h.runtime.session.sessionManager.getEntries());
		expect(h.notices.at(-1)?.message).toContain("cancelled");
		expect(h.errors).toEqual([]);
	});

	it("restores the original file and reports recovery when a before-switch hook appends into the deleted turn", async () => {
		let enabled = true;
		const h = await harness({ seed: (manager) => { user(manager, "Base"); answer(manager); user(manager, "Keep after failure"); answer(manager); }, extra: (pi) => {
			pi.on("session_before_switch", () => { if (enabled) pi.appendEntry("conflicting-note", { stale: true }); });
		} });
		const path = h.runtime.session.sessionFile!;
		const before = readFileSync(path, "utf8");
		await h.undo();
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(h.editor()).toBe("");
		expect(h.notices.at(-1)?.message).toContain("Resume the saved session");
		expect(h.notices.at(-1)?.type).toBe("error");
		enabled = false;
		await h.runtime.switchSession(path);
		expect(h.runtime.session.sessionManager.getEntries()).toEqual(disk(h.runtime).getEntries());
		expect(h.runtime.session.messages).toContainEqual(expect.objectContaining({ role: "user", content: "Keep after failure" }));
		expect(h.errors).toEqual([]);
		assertNoUndoArtifacts(h.root);
	});

	it("does not accept new entries from session-start hooks during undo", async () => {
		const h = await harness({ seed: (manager) => { user(manager, "Keep"); answer(manager); }, extra: (pi) => {
			pi.on("session_start", (event) => { if (event.reason === "resume") pi.appendEntry("startup-note", { new: true }); });
		} });
		const path = h.runtime.session.sessionFile!;
		const before = readFileSync(path, "utf8");
		await h.undo();
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(h.editor()).toBe("");
		expect(h.notices.at(-1)?.type).toBe("error");
		expect(h.notices.at(-1)?.message).toContain("Session-start hooks changed");
		expect(h.errors).toEqual([]);
		assertNoUndoArtifacts(h.root);
	});

	it("supports the first turn and refuses to overwrite the restored draft on a repeated undo", async () => {
		const h = await harness({ seed: (manager) => { user(manager, "First turn"); answer(manager); } });
		await h.undo();
		expect(disk(h.runtime).getEntries().filter((entry) => entry.type === "message")).toEqual([]);
		expect(h.editor()).toBe("First turn");
		await h.undo();
		expect(h.editor()).toBe("First turn");
		expect(h.requests).toEqual([]);
	});

	it.each(["draft", "attachment", "external-change", "malformed", "lock", "print", "in-memory"])("safely refuses %s without changing the turn", async (condition) => {
		const h = await harness({ seed: (manager) => {
			if (condition === "attachment") manager.appendMessage({ role: "user", content: [{ type: "text", text: "With image" }, { type: "image", mimeType: "image/png", data: "image" }], timestamp: Date.now() });
			else user(manager, "Keep this prompt");
			answer(manager);
		}, mode: condition === "print" ? "print" : "tui", inMemory: condition === "in-memory" });
		const path = h.runtime.session.sessionFile;
		if (condition === "draft") h.setEditor("Unsaved draft");
		if (condition === "external-change") SessionManager.open(path!).appendSessionInfo("Externally changed");
		if (condition === "malformed") writeFileSync(path!, readFileSync(path!, "utf8") + "broken JSON\n");
		if (condition === "lock") writeFileSync(`${path}.undo.lock`, "Another undo");
		const before = path ? readFileSync(path, "utf8") : undefined;
		const entries = h.runtime.session.sessionManager.getEntries();
		await h.undo();
		expect(h.runtime.session.sessionManager.getEntries()).toEqual(entries);
		if (path) expect(readFileSync(path, "utf8")).toBe(before);
		expect(h.editor()).toBe(condition === "draft" ? "Unsaved draft" : "");
		expect(h.notices.at(-1)?.type).toMatch(/warning|error/);
		expect(h.errors).toEqual([]);
	});

	it("does not delete an earlier turn while a before-agent-start hook is preparing the new submission", async () => {
		let release: () => void = () => {};
		let ready: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const entered = new Promise<void>((resolve) => { ready = resolve; });
		const h = await harness({ seed: (manager) => { user(manager, "Earlier"); answer(manager); }, extra: (pi) => {
			pi.on("before_agent_start", async () => { ready(); await gate; });
		} });
		const before = h.runtime.session.sessionManager.getEntries();
		const preparing = h.runtime.session.prompt("New submission");
		await entered;
		try {
			await h.undo();
			expect(h.runtime.session.sessionManager.getEntries()).toEqual(before);
			expect(h.notices.at(-1)?.message).toContain("still being prepared");
		} finally { release(); await preparing; }
		await h.undo();
		expect(h.editor()).toBe("New submission");
		expect(h.errors).toEqual([]);
	});

	it("refuses queued prompts rather than dropping them during replacement", async () => {
		const h = await harness({ seed: (manager) => { user(manager, "Base"); answer(manager); } });
		const received = h.holdNext("before-text");
		const running = h.runtime.session.prompt("Running");
		await received;
		await h.runtime.session.prompt("Queued", { streamingBehavior: "followUp" });
		await h.undo();
		expect(h.runtime.session.getFollowUpMessages()).toEqual(["Queued"]);
		expect(h.notices.at(-1)?.message).toContain("queued prompts");
		await h.runtime.session.abort(); await running;
	});
});
