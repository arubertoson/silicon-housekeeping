import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	convertToLlm, createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import commitExtension from "../extensions/commit.ts";
import { createCommitSession, disposeCommitSession } from "../support/commit-session.ts";

initTheme("dark", false);

const roots: string[] = [];
const sessions: AgentSession[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: "/dev/null" };
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-commit-"));
	roots.push(root);
	return root;
}
function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
	return result.stdout;
}

async function parent(cwd: string, script?: string, unsupportedOff = false, options: { codemode?: boolean; extensions?: string[] } = {}) {
	const codemode = options.codemode ?? false;
	const agentDir = workspace();
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	const model = {
		id: "implementation-model", name: "Test", provider: "test", api: "openai-responses" as const,
		baseUrl: "http://invalid", reasoning: true, input: ["text" as const],
		contextWindow: 200000, maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(unsupportedOff ? { thinkingLevelMap: { off: null, minimal: null, low: "low" } } : {}),
	};
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false } });
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.hasConfiguredAuth = () => true;
	runtime.getModel = () => model;
	let api!: ExtensionAPI;
	let ctx!: ExtensionCommandContext;
	let calls = 0;
	const requests: { context: Parameters<ModelRuntime["streamSimple"]>[1]; options: unknown }[] = [];
	let wait: ((signal: AbortSignal) => Promise<void>) | undefined;
	runtime.streamSimple = (_model, context, options) => {
		requests.push(structuredClone({ context, options: { reasoning: options?.reasoning, sessionId: options?.sessionId, transport: options?.transport } }));
		const commit = JSON.stringify(context.messages.at(-1)).includes("Create a local change");
		const content = commit && script && calls++ === 0
			? [{ type: "toolCall" as const, id: "commit-tool", name: "bash", arguments: { command: script } }]
			: [{ type: "text" as const, text: "chore: update target" }];
		const message = {
			role: "assistant" as const, content, api: model.api, provider: model.provider, model: model.id,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: content[0].type === "toolCall" ? "toolUse" as const : "stop" as const, timestamp: Date.now(),
		};
		return {
			async *[Symbol.asyncIterator]() {
				if (wait) await wait(options!.signal!);
				yield { type: "done" as const, reason: message.stopReason, message };
			},
			result: async () => message,
		} as unknown as ReturnType<ModelRuntime["streamSimple"]>;
	};
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
		systemPrompt: "Keep the configured prompt.",
		additionalExtensionPaths: [...(codemode ? ["builtin:codemode"] : []), ...(options.extensions ?? [])],
		extensionFactories: [...(codemode ? [{ name: "codemode", factory: createCodemodeExtension(), builtin: true }] : []), (pi) => {
			api = pi;
			commitExtension(pi);
			pi.registerCommand("capture", { description: "Test context", handler: async (_args, context) => { ctx = context; } });
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, thinkingLevel: "high", sessionManager: SessionManager.inMemory(cwd) });
	sessions.push(session);
	const notify = vi.fn();
	const status = vi.fn();
	const custom: ExtensionCommandContext["ui"]["custom"] = async (factory) => new Promise((resolve) => {
		let component: { dispose?: () => void };
		component = factory(
			{ requestRender() {} } as never,
			{ fg: (_color: string, text: string) => text } as never,
			{} as never,
			(result) => { component?.dispose?.(); resolve(result); },
		) as typeof component;
	});
	await session.bindExtensions({ mode: "tui", onError: (error) => { throw new Error(JSON.stringify(error)); }, uiContext: { notify, setStatus: status, custom } as unknown as ExtensionCommandContext["ui"] });
	if (codemode) session.setActiveToolsByName(["codemode"]);
	await session.prompt("Implement target.txt only.");
	await session.prompt("/capture");
	requests.length = 0;
	const snapshot = () => structuredClone({ entries: session.sessionManager.getEntries(), settings: settings.getSettings(), model: session.model, thinking: session.thinkingLevel, tools: session.getActiveToolNames() });
	return { session, api, ctx, requests, notify, status, snapshot, agentDir,
		block: (fn: typeof wait) => { wait = fn; },
	};
}

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("/commit disposable session", () => {
	it("commits explicit Git paths from a subdirectory, leaves unrelated staged/unstaged work and parent state intact", async () => {
		const root = workspace();
		run("git", ["init", "--quiet", root], root);
		run("git", ["config", "user.name", "Test"], root);
		run("git", ["config", "user.email", "test@example.invalid"], root);
		for (const file of ["target.txt", "staged.txt", "other.txt"]) writeFileSync(join(root, file), "before\n");
		run("git", ["add", "--", "target.txt", "staged.txt", "other.txt"], root);
		run("git", ["commit", "--quiet", "-m", "initial"], root);
		for (const file of ["target.txt", "staged.txt", "other.txt"]) writeFileSync(join(root, file), "after\n");
		run("git", ["add", "--", "staged.txt"], root);
		mkdirSync(join(root, "src"));
		const p = await parent(join(root, "src"), "git status --short && git diff && git diff --cached && git add -- ../target.txt && git commit --only -m 'chore: update target' -- ../target.txt");
		const before = p.snapshot();
		await p.session.prompt("/commit target.txt");
		expect(p.snapshot()).toEqual(before);
		expect(run("git", ["show", "--format=", "--name-only", "HEAD"], root).trim()).toBe("target.txt");
		expect(run("git", ["diff", "--cached", "--name-only"], root).trim()).toBe("staged.txt");
		expect(run("git", ["diff", "--name-only"], root).trim()).toBe("other.txt");
		expect(p.requests[0].options).toEqual({ reasoning: undefined, sessionId: p.session.sessionId, transport: "sse" });
		expect(p.notify).toHaveBeenCalledWith("chore: update target", "info");
		expect(p.status).toHaveBeenLastCalledWith("commit", undefined);
		expect(readdirSync(p.agentDir)).not.toContain("sessions");
	});

	it("prefers colocated jj, describes then creates a fresh working-copy change", async () => {
		const root = workspace();
		run("jj", ["git", "init", "--colocate", root], root);
		writeFileSync(join(root, "target.txt"), "after\n");
		const p = await parent(root, "jj status && jj diff && jj describe -m 'chore: update target' && jj new");
		const before = p.snapshot();
		await p.session.prompt("/commit target.txt");
		expect(p.snapshot()).toEqual(before);
		expect(JSON.stringify(p.requests[0].context)).toContain("Selected VCS: jj");
		expect(run("jj", ["log", "--no-graph", "-r", "@-", "-T", "description"], root).trim()).toBe("chore: update target");
		expect(run("jj", ["diff", "--summary"], root)).toBe("");
	});

	it("uses the nearest repository and stops rather than crossing a malformed boundary", async () => {
		const root = workspace();
		run("jj", ["git", "init", "--colocate", root], root);
		const nested = join(root, "nested");
		mkdirSync(nested);
		run("git", ["init", "--quiet", nested], nested);
		const p = await parent(nested);
		await p.session.prompt("/commit");
		expect(JSON.stringify(p.requests[0].context)).toContain("Selected VCS: git");
		rmSync(join(nested, ".git"), { recursive: true });
		mkdirSync(join(nested, ".git"));
		p.requests.length = 0;
		const before = p.snapshot();
		await p.session.prompt("/commit");
		expect(p.requests).toHaveLength(0);
		expect(p.notify).toHaveBeenLastCalledWith(expect.stringContaining("commit not started"), "error");
		expect(p.snapshot()).toEqual(before);
	});

	it("fails closed outside TUI and releases ownership when the modal cannot start", async () => {
		const root = workspace(); run("git", ["init", "--quiet", root], root);
		const p = await parent(root);
		await p.session.bindExtensions({ mode: "rpc" });
		const before = p.snapshot();
		await p.session.prompt("/commit");
		expect(p.notify).toHaveBeenLastCalledWith(expect.stringContaining("requires interactive TUI"), "error");
		expect(p.requests).toHaveLength(0);
		expect(p.snapshot()).toEqual(before);
		await p.session.bindExtensions({ mode: "tui" });
		const custom = p.ctx.ui.custom;
		p.ctx.ui.custom = async () => { throw new Error("Modal failed"); };
		await expect(p.session.prompt("/commit")).rejects.toThrow("Modal failed");
		p.ctx.ui.custom = custom;
		await p.session.prompt("/commit");
		expect(p.notify).toHaveBeenLastCalledWith("chore: update target", "info");
		expect(p.snapshot()).toEqual(before);
	});

	it("preserves compaction, context edits, branches, reasoning signatures and the projected prefix", async () => {
		const p = await parent(workspace());
		const manager = p.session.sessionManager;
		const kept = manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		manager.appendCompaction("compacted history", kept, 50000);
		manager.appendContextEdit(kept, { content: "edited" });
		const historical = p.session.messages.findLast((message) => message.role === "assistant")!;
		if (historical.role !== "assistant") throw new Error("Missing historical assistant fixture");
		manager.appendMessage({ ...structuredClone(historical), content: [
			{ type: "thinking", thinking: "Historical reasoning", thinkingSignature: "opaque-signature" },
			{ type: "text", text: "Historical reply", textSignature: "opaque-text-signature" },
		] });
		manager.appendCustomEntry("state", { nested: { value: 1 } });
		const leaf = manager.getLeafId()!;
		manager.appendMessage({ role: "user", content: "abandoned", timestamp: 2 });
		manager.branch(leaf);
		p.session.refreshContext();
		const prefix = convertToLlm(manager.buildSessionContext().messages);
		const before = p.snapshot();
		const clone = await createCommitSession(p.api, p.ctx, { agentDir: p.agentDir });
		try {
			expect(clone.sessionManager.getSessionFile()).toBeUndefined();
			expect(clone.sessionId).not.toBe(p.session.sessionId);
			expect(clone.sessionManager.buildSessionContext().messages).toEqual(manager.buildSessionContext().messages);
			const state = clone.sessionManager.getBranch().find((entry) => entry.type === "custom" && entry.customType === "state")!;
			if (state.type === "custom") (state.data as { nested: { value: number } }).nested.value = 2;
			await clone.prompt("Create a local change; report only.");
			expect(p.requests[0].context.messages.slice(0, prefix.length)).toEqual(prefix);
			expect(JSON.stringify(p.requests[0].context)).toContain("opaque-signature");
			expect(JSON.stringify(p.requests[0].context)).not.toContain("abandoned");
			expect(JSON.stringify(p.requests[0].context)).toContain("edited");
			expect(p.snapshot()).toEqual(before);
		} finally { await disposeCommitSession(clone); }
	});

	it("preserves the codemode loadout and hidden callable tool declarations at the request boundary", async () => {
		const p = await parent(workspace(), undefined, false, { codemode: true });
		const before = p.snapshot();
		const prefix = convertToLlm(p.session.messages);
		const clone = await createCommitSession(p.api, p.ctx, { agentDir: p.agentDir });
		try {
			expect(clone.getActiveToolNames()).toEqual(["codemode"]);
			await clone.prompt("Create a local change; report only.");
			expect(clone.getLastAssistantText()).toBe("chore: update target");
			expect(p.requests[0].context.messages.slice(0, prefix.length)).toEqual(prefix);
			expect(p.snapshot()).toEqual(before);
		} finally { await disposeCommitSession(clone); }
	});

	it("uses the lowest supported thinking level without changing the parent", async () => {
		const root = workspace(); run("git", ["init", "--quiet", root], root);
		const p = await parent(root, undefined, true);
		const before = p.snapshot();
		await p.session.prompt("/commit");
		expect(p.requests[0].options).toMatchObject({ reasoning: "low" });
		expect(p.snapshot()).toEqual(before);
	});

	it("cancels, keeps the working-copy lease until settled, and blocks concurrent input/bash/tools", async () => {
		const root = workspace(); run("git", ["init", "--quiet", root], root);
		const p = await parent(root);
		const before = p.snapshot();
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		p.block(async (signal) => { entered(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); });
		const work = p.session.prompt("/commit");
		await ready;
		await p.session.prompt("/commit");
		expect(p.notify).toHaveBeenCalledWith(expect.stringContaining("Wait for current work"), "warning");
		expect(await p.session.extensionRunner.emitInput("new parent work", undefined, "interactive")).toMatchObject({ action: "handled" });
		expect(await p.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "parent", input: { command: "touch unsafe" } })).toMatchObject({ block: true });
		expect(await p.session.extensionRunner.emitUserBash({ type: "user_bash", command: "touch unsafe", excludeFromContext: false, cwd: root })).toMatchObject({ result: { exitCode: 1 } });
		await p.session.prompt("/commit cancel");
		await work;
		expect(p.snapshot()).toEqual(before);
		expect(p.notify).toHaveBeenCalledWith(expect.stringContaining("not rolled back"), "warning");
		p.block(undefined);
		await p.session.prompt("/commit");
		expect(p.notify).toHaveBeenLastCalledWith("chore: update target", "info");
	});

	it("cancels during extension startup, shuts down only the scratch instance, and leaves the parent untouched", async () => {
		const root = workspace();
		const marker = join(root, "lifecycle.txt");
		const gate = join(root, "release");
		const extension = join(root, "lifecycle.ts");
		writeFileSync(extension, `import { appendFileSync, existsSync } from "node:fs";
export default function(pi) {
	pi.registerCommand("lifecycle-probe", { description: "Fixture", handler: async () => {} });
	pi.on("session_start", async (_event, ctx) => {
		const clone = ctx.sessionManager.getBranch().some(entry => entry.type === "message");
		appendFileSync(${JSON.stringify(marker)}, clone ? "clone-start\\n" : "parent-start\\n");
		if (clone) while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 5));
	});
	pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(marker)}, "shutdown\\n"));
}`);
		const p = await parent(root, undefined, false, { extensions: [extension] });
		const before = p.snapshot();
		const controller = new AbortController();
		const creating = createCommitSession(p.api, p.ctx, { agentDir: p.agentDir, signal: controller.signal });
		const rejected = expect(creating).rejects.toThrow("aborted");
		try {
			await vi.waitFor(() => expect(readFileSync(marker, "utf8")).toContain("clone-start"));
			controller.abort();
		} finally { writeFileSync(gate, "release"); }
		await rejected;
		expect(readFileSync(marker, "utf8")).toBe("parent-start\nclone-start\nshutdown\n");
		expect(p.requests).toHaveLength(0);
		expect(p.snapshot()).toEqual(before);
	});

	it("fails closed if extension startup changes the cloned prefix or a request hook throws", async () => {
		const root = workspace();
		const extension = join(root, "transform.ts");
		const drift = join(root, "drift");
		const hookError = join(root, "hook-error");
		writeFileSync(extension, `import { existsSync } from "node:fs";
export default function(pi) {
	pi.registerCommand("transform-probe", { description: "Fixture", handler: async () => {} });
	pi.on("session_start", () => {
		if (existsSync(${JSON.stringify(drift)})) pi.sendMessage({ customType: "startup", content: "Changed prefix", display: false });
	});
	pi.on("context", () => { if (existsSync(${JSON.stringify(hookError)})) throw new Error("Transform failed"); });
}`);
		const p = await parent(root, undefined, false, { extensions: [extension] });
		const before = p.snapshot();
		writeFileSync(drift, "drift");
		await expect(createCommitSession(p.api, p.ctx, { agentDir: p.agentDir })).rejects.toThrow("changed the cloned conversation prefix");
		rmSync(drift);
		const clone = await createCommitSession(p.api, p.ctx, { agentDir: p.agentDir });
		try {
			writeFileSync(hookError, "fail");
			await clone.prompt("Create a local change");
			expect(clone.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: expect.stringContaining("Transform failed") });
			expect(p.requests).toHaveLength(0);
			expect(p.snapshot()).toEqual(before);
		} finally { await disposeCommitSession(clone); }
	});

	it("releases working-copy ownership even when a scratch shutdown hook fails", async () => {
		const root = workspace(); run("git", ["init", "--quiet", root], root);
		const failure = join(root, "fail-cleanup");
		const extension = join(root, "cleanup.ts");
		writeFileSync(extension, `import { existsSync } from "node:fs";
export default function(pi) {
	pi.registerCommand("cleanup-probe", { description: "Fixture", handler: async () => {} });
	pi.on("session_shutdown", () => { if (existsSync(${JSON.stringify(failure)})) throw new Error("Cleanup failed"); });
}`);
		const p = await parent(root, undefined, false, { extensions: [extension] });
		const before = p.snapshot();
		writeFileSync(failure, "fail");
		await expect(p.session.prompt("/commit")).rejects.toThrow("Cleanup failed");
		rmSync(failure);
		await p.session.prompt("/commit");
		expect(p.requests).toHaveLength(2);
		expect(p.notify).toHaveBeenLastCalledWith("chore: update target", "info");
		expect(p.snapshot()).toEqual(before);
	});

	it("stops outside a repository, on unreconstructable tools, and on incompatible effective prompts", async () => {
		const p = await parent(workspace());
		await p.session.prompt("/commit");
		expect(p.requests).toHaveLength(0);
		expect(p.notify).toHaveBeenCalledWith(expect.stringContaining("Not in a Git or jj repository"), "error");
		const tools = p.api.getAllTools();
		p.api.getAllTools = () => [...tools, { ...tools[0], name: "uncloneable", sourceInfo: { ...tools[0].sourceInfo, path: "<sdk:uncloneable>" } }];
		await expect(createCommitSession(p.api, p.ctx, { agentDir: p.agentDir })).rejects.toThrow("tool registry/loadout");
		p.api.getAllTools = () => tools;
		const ctx = { ...p.ctx, getSystemPrompt: () => "Runtime-only forced prompt" };
		const clone = await createCommitSession(p.api, ctx, { agentDir: p.agentDir });
		try {
			await clone.prompt("Create a local change");
			expect(clone.getLastAssistantText()).toBeUndefined();
			expect(p.requests).toHaveLength(0);
		} finally { await disposeCommitSession(clone); }
	});
});
