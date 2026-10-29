// Runner regressions adapted from pasky/pi-amplike; the retained MIT licence
// and adoption provenance are in ../extensions/subagent.ts.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { captureSubagentTools, type SubagentToolSetup } from "../support/subagent-tools.js";

type Settings = ReturnType<ExtensionAPI["getSettings"]>;

const captured = vi.hoisted(() => ({
	options: [] as CreateAgentSessionOptions[],
	stream: undefined as AgentSession["agent"]["streamFunction"] | undefined,
}));
const nativePrompt = AgentSession.prototype.prompt;

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...sdk,
		async createAgentSession(options: CreateAgentSessionOptions) {
			captured.options.push(options);
			return sdk.createAgentSession(options);
		},
	};
});

let root: string;
let cwd: string;
let agentDir: string;
let extension: string;
let runSubagent: typeof import("../extensions/subagent.js").runSubagent;
let model: NonNullable<AgentSession["model"]>;
/** Shared parent with the explicit extension; tests needing other sources build their own. */
let base: Awaited<ReturnType<typeof parentSetup>>;
const snapshots = new Map<string, {
	tools: string[];
	prompt: string;
	messages: number;
	model: string | undefined;
	thinking: string;
	sessionFile: string | undefined;
}>();

async function registeredTool(api: Partial<ExtensionAPI> = {}): Promise<ToolDefinition> {
	const { default: register } = await import("../extensions/subagent.js");
	let definition: ToolDefinition | undefined;
	register({
		registerTool: (tool: ToolDefinition) => { definition = tool; },
		getThinkingLevel: () => "off",
		getSettings: () => ({ cacheWarming: "off" }),
		getAllTools: () => [],
		getActiveTools: () => [],
		getMcpServers: () => [],
		...api,
	} as unknown as ExtensionAPI);
	if (!definition) throw new Error("subagent tool not registered");
	return definition;
}

async function run(task: string, options: { tools?: string[]; toolSetup?: SubagentToolSetup } = {}) {
	return runSubagent({
		cwd,
		model,
		thinkingLevel: "off",
		task,
		toolSetup: base.setup,
		...options,
		onProgress: () => {},
	});
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "pi-child-"));
	cwd = join(root, "workspace");
	agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("HOME", root);
	vi.stubEnv("ANTHROPIC_API_KEY", "offline-test-key");

	extension = join(root, "explicit.js");
	writeFileSync(extension, `export default function (pi) {
		for (const name of ["extra", "other"]) {
			pi.registerTool({ name, label: name, description: name,
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [], details: {} }) });
		}
		pi.on("session_start", () => pi.setActiveTools(["read", "extra", "other", "bash"]));
	}`);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		cacheWarming: "off", retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
	}));

	({ runSubagent } = await import("../extensions/subagent.js"));
	const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	model = runtime.getModels().find((entry) => entry.provider === "anthropic")!;
	expect(model).toBeDefined();

	// Exercise real SDK construction, extension binding and resources offline.
	// Stop at prompt entry: no provider request, credentials or tokens required.
	vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, prompt: string) {
		const task = prompt.split("\n").at(-1)!;
		snapshots.set(task, {
			tools: this.getActiveToolNames().sort(),
			prompt: this.systemPrompt,
			messages: this.messages.length,
			model: this.model?.id,
			thinking: this.thinkingLevel,
			sessionFile: this.sessionManager.getSessionFile(),
		});
		if (captured.stream) {
			this.agent.streamFunction = captured.stream;
			return nativePrompt.call(this, prompt, { source: "extension" });
		}
		throw new Error("offline prompt boundary");
	});
	base = await parentSetup({ active: ["read", "extra", "bash"], settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } });
});

beforeEach(() => {
	snapshots.clear();
	captured.options.length = 0;
	captured.stream = undefined;
});

afterAll(async () => {
	await base.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("child configuration through the installed Pi SDK", () => {
	it("inherits the captured loadout with fresh context, parent model and subagent preamble", async () => {
		const result = await run("default");
		expect(result.errorMessage).toBe("offline prompt boundary");
		const snapshot = snapshots.get("default")!;
		expect(snapshot.tools).toEqual(["bash", "extra", "read"]);
		expect(snapshot.messages).toBe(0);
		expect(snapshot.model).toBe(model.id);
		expect(snapshot.prompt).toContain("operating as a subagent");
		expect(captured.options[0].thinkingLevel).toBe("off");
		// The SDK may clamp the inherited level to the selected model's support.
		expect(snapshot.thinking).toBeTruthy();
		expect(snapshot.sessionFile).toBeTruthy();
	});

	it("does not rediscover parent extensions", async () => {
		const discovered = join(agentDir, "extensions", "must-not-load.js");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(discovered, 'throw new Error("parent extension must not load");');
		try {
			const result = await run("no-extensions");
			expect(result.errorMessage).toBe("offline prompt boundary");
		} finally {
			rmSync(join(agentDir, "extensions"), { recursive: true });
		}
	});

	it.each(["not-a-tool", "*", "+read"])("rejects unknown/non-exact tool %s before prompting", async (name) => {
		const result = await run("invalid", { tools: [name] });
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("Unknown child tools");
		expect(snapshots.size).toBe(0);
	});

	it("never lets children inherit the subagent tool", async () => {
		const tools = base.session.getAllTools();
		const definition = await registeredTool({
			...base.api,
			getAllTools: () => [...tools, { ...tools.find((tool) => tool.name === "extra")!, name: "subagent" }],
			getActiveTools: () => [...base.session.getActiveToolNames(), "subagent"],
		});
		await definition.execute("call", { tasks: ["no recursion"] }, undefined, undefined, {
			cwd, model, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined },
		} as unknown as ExtensionToolContext);
		expect(snapshots.get("no recursion")?.tools).toEqual(["bash", "extra", "read"]);
	});

	it("passes the tool list to every child through the tool interface", async () => {
		const definition = await registeredTool(base.api);
		const context = {
			cwd,
			model,
			modelRegistry: {},
			isProjectTrusted: () => true,
			sessionManager: {
				getSessionFile: () => undefined,
				getBranch: () => { throw new Error("must not read parent conversation"); },
			},
		} as unknown as ExtensionToolContext;
		await definition.execute("call", { tasks: ["schema-a", "schema-b"], tools: [] }, undefined, undefined, context);
		for (const task of ["schema-a", "schema-b"]) {
			expect(snapshots.get(task)?.tools).toEqual([]);
			expect(snapshots.get(task)?.model).toBe(model.id);
		}
	});

	it("keeps concurrent child configurations and the parent independent", async () => {
		const parentTools = base.session.getActiveToolNames();
		const parentPrompt = base.session.systemPrompt;
		await Promise.all([
			run("first", { tools: ["read"] }),
			run("second", { tools: [] }),
			run("default-child"),
		]);
		expect(snapshots.get("first")?.tools).toEqual(["read"]);
		expect(snapshots.get("second")?.tools).toEqual([]);
		expect(snapshots.get("default-child")?.tools).toEqual(["bash", "extra", "read"]);
		expect(base.session.getActiveToolNames()).toEqual(parentTools);
		expect(base.session.systemPrompt).toBe(parentPrompt);
		expect(new Set(captured.options.map((options) => options.resourceLoader)).size).toBe(3);
		expect(new Set(captured.options.map((options) => options.settingsManager)).size).toBe(3);
	});
});

it("keeps task previews bounded and explicit model badges readable", async () => {
	const { clampTaskForDisplay, formatAgentBadge, TASK_DISPLAY_LINES } = await import("../extensions/subagent.js");
	expect(clampTaskForDisplay("a\nb\n\n", 3)).toBe("a\nb");
	expect(clampTaskForDisplay("1\n2\n3\n4\n5", 3)).toBe("1\n2\n… +3 more lines");
	expect(clampTaskForDisplay(Array.from({ length: 100 }, (_, i) => i).join("\n")).split("\n")).toHaveLength(TASK_DISPLAY_LINES);
	expect(formatAgentBadge()).toBeUndefined();
	expect(formatAgentBadge("   ")).toBeUndefined();
	expect(formatAgentBadge("provider/\nmodel")).toBe("provider/ model");
	expect(formatAgentBadge("x".repeat(100))).toHaveLength(40);
});

// Synthetic provider responses exercise Pi's actual run/retry/cancellation path
// without credentials, networking, or a simulated AgentSession lifecycle.
function answer(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", api: model.api, provider: model.provider, model: model.id,
		content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...overrides,
	};
}

it("waits for native retries, persists the final answer, and disposes", async () => {
	let attempts = 0;
	captured.stream = () => {
		const stream = createAssistantMessageEventStream();
		if (++attempts === 1) {
			stream.push({ type: "error", reason: "error", error: answer("", { stopReason: "error", errorMessage: "429 rate limit" }) });
		} else {
			stream.push({ type: "done", reason: "stop", message: answer("final answer") });
		}
		return stream;
	};
	const dispose = vi.spyOn(AgentSession.prototype, "dispose");
	const updates: string[] = [];
	try {
		const result = await runSubagent({
			cwd, model, thinkingLevel: "off", task: "native retry", tools: [], toolSetup: base.setup,
			onProgress: (r) => { updates.push(...r.displayItems.filter((i) => i.type === "text").map((i) => i.text)); },
		});
		expect(attempts).toBe(2);
		expect(result.status).toBe("succeeded");
		expect(result.finalOutput).toBe("final answer");
		expect(result.errorMessage).toBeUndefined();
		expect(result.usage.output).toBeGreaterThanOrEqual(2);
		expect(updates.some((text) => text.includes("retry 1/1"))).toBe(true);
		expect(readFileSync(result.sessionFile!, "utf8")).toContain("final answer");
		expect(dispose).toHaveBeenCalledOnce();
	} finally {
		dispose.mockRestore();
	}
});

it("cancels an active native stream before disposing the child", async () => {
	const controller = new AbortController();
	let started = () => {};
	const ready = new Promise<void>((resolve) => { started = resolve; });
	let providerAborted = false;
	captured.stream = (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: answer("") });
		options?.signal?.addEventListener("abort", () => {
			providerAborted = true;
			stream.push({ type: "error", reason: "aborted", error: answer("partial", { stopReason: "aborted" }) });
		}, { once: true });
		started();
		return stream;
	};
	const dispose = vi.spyOn(AgentSession.prototype, "dispose");
	try {
		const pending = runSubagent({
			cwd, model, thinkingLevel: "off", task: "cancel stream", signal: controller.signal,
			tools: [], toolSetup: base.setup, onProgress: () => { throw new Error("UI unavailable"); },
		});
		await ready;
		controller.abort();
		const result = await pending;
		expect(providerAborted).toBe(true);
		expect(result.status).toBe("failed");
		expect(result.stopReason).toBe("aborted");
		expect(dispose).toHaveBeenCalledOnce();
	} finally {
		dispose.mockRestore();
	}
});

it("does not create a child when already cancelled", async () => {
	const result = await runSubagent({
		cwd, model, thinkingLevel: "off", task: "already cancelled",
		toolSetup: base.setup, signal: AbortSignal.abort(), onProgress: () => {},
	});
	expect(result.stopReason).toBe("aborted");
	expect(captured.options).toHaveLength(0);
});

it("emits extension shutdown even when prompt fails", async () => {
	const marker = join(root, "shutdown.txt");
	const cleanup = join(root, "cleanup.js");
	writeFileSync(cleanup, `import { writeFileSync } from "node:fs";
		export default function(pi) {
			pi.registerTool({ name: "cleanup", label: "cleanup", description: "cleanup", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
			pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(marker)}, "closed"));
		}`);
	const parent = await parentSetup({ paths: [cleanup], active: ["read", "cleanup"] });
	try {
		const result = await run("failure cleanup", { toolSetup: parent.setup });
		expect(result.status).toBe("failed");
		expect(readFileSync(marker, "utf8")).toBe("closed");
	} finally { await parent.close(); }
});

it.each(["no-slash", "missing/model"])("rejects unresolved explicit model %s without starting children", async (requested) => {
	const definition = await registeredTool();
	const result = await definition.execute("call", { tasks: ["model check"], model: requested }, undefined, undefined, {
		cwd, model, modelRegistry: { find: () => undefined },
	} as unknown as ExtensionToolContext);
	expect(result.isError).toBe(true);
	expect(captured.options).toHaveLength(0);
});

it("uses an explicit model instead of the parent model and removes mode from the schema", async () => {
	const definition = await registeredTool();
	const selected = { ...model, id: "explicit-offline-model" };
	await definition.execute("call", { tasks: ["explicit model"], model: `${selected.provider}/${selected.id}` }, undefined, undefined, {
		cwd, model, isProjectTrusted: () => true,
		modelRegistry: { find: (provider: string, id: string) => provider === selected.provider && id === selected.id ? selected : undefined },
		sessionManager: { getSessionFile: () => undefined },
	} as unknown as ExtensionToolContext);
	expect(snapshots.get("explicit model")?.model).toBe(selected.id);
	expect(captured.options[0].thinkingLevel).toBe("off");
	expect(definition.parameters).not.toHaveProperty("properties.mode");
});

it("retains collapsed progress, expanded Markdown, tool previews and usage rendering", async () => {
	const { renderResults, emptyUsage } = await import("../extensions/subagent.js");
	initTheme("dark", false);
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
	const result = {
		task: "Review draft", status: "succeeded" as const, finalOutput: "# Answer\n\nA concise result.", agentBadge: "provider/model",
		displayItems: [{ type: "toolCall" as const, name: "read", args: { path: "/tmp/draft.md" } }],
		usage: { ...emptyUsage(), turns: 3, input: 1200 },
	};
	const collapsed = stripVTControlCharacters(renderResults([result], false, theme).render(100).join("\n"));
	expect(collapsed).toContain("[provider/model]");
	expect(collapsed).toContain("read /tmp/draft.md");
	expect(collapsed).toContain("3 turns ↑1.2k");
	expect(collapsed).toContain("Ctrl+O to expand");
	const expanded = stripVTControlCharacters(renderResults([result], true, theme).render(100).join("\n"));
	expect(expanded).toContain("Answer");
	expect(expanded).toContain("A concise result.");
	expect(expanded).not.toContain("Ctrl+O to expand");
	const running = stripVTControlCharacters(renderResults([{ ...result, status: "running" }], true, theme).render(100).join("\n"));
	expect(running).toContain("1 running");
});

// Real parent/child construction; only the provider stream is synthetic.
async function parentSetup(options: {
	active?: string[];
	paths?: string[];
	settings?: Settings;
	mcp?: boolean;
	mcpServer?: ReturnType<ExtensionAPI["getMcpServers"]>[number]["config"];
} = {}) {
	let registeredServers: ExtensionAPI["getMcpServers"] = () => [];
	const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", ...options.settings });
	settingsManager.setProjectTrusted(true);
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true,
		additionalExtensionPaths: [...(options.paths ?? [extension]), "builtin:codemode", "builtin:tool_search", ...(options.mcp ? ["builtin:mcp"] : [])],
		extensionFactories: [
			{ name: "codemode", factory: createCodemodeExtension(), builtin: true },
			{ name: "tool_search", factory: createToolSearchExtension(), builtin: true },
			...(options.mcp ? [{ name: "mcp", factory: createMcpExtension(), builtin: true }] : []),
			(pi) => {
				registeredServers = () => pi.getMcpServers();
				if (options.mcpServer) pi.registerMcpServer("fixture", options.mcpServer);
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd, agentDir, model, settingsManager, resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({});
	if (options.mcp) {
		const deadline = Date.now() + 5_000;
		while (!session.getAllTools().some((tool) => tool.name === "mcp__fixture__echo")) {
			if (Date.now() >= deadline) throw new Error("Fixture MCP server did not connect");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	session.setActiveToolsByName(options.active ?? ["read", "extra", "codemode"]);
	const api: Partial<ExtensionAPI> = {
		getSettings: () => settingsManager.getSettings(),
		getAllTools: () => session.getAllTools(),
		getActiveTools: () => session.getActiveToolNames(),
		getMcpServers: registeredServers,
	};
	const setup = captureSubagentTools(api as ExtensionAPI, true);
	return { session, setup, api, async close() {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	} };
}

function toolConversation(name: string, args: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"], check: (text: string) => void) {
	captured.stream = (_model, context) => {
		const stream = createAssistantMessageEventStream();
		if (!context.messages.some((message) => message.role === "toolResult")) {
			const message = answer("", {
				content: [{ type: "toolCall", id: "child-call", name, arguments: args }], stopReason: "toolUse",
			});
			stream.push({ type: "done", reason: "toolUse", message });
		} else {
			const result = context.messages.findLast((message) => message.role === "toolResult");
			expect(result).toBeDefined();
			check(result!.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
			stream.push({ type: "done", reason: "stop", message: answer("verified child result") });
		}
		return stream;
	};
}

describe("session-derived child capabilities", () => {
	it("inherits source-backed tools, effective settings and callable exposure without copying history", async () => {
		const parent = await parentSetup({ settings: { codemode: { mode: "only" } } });
		const parentPrompt = parent.session.systemPrompt;
		const parentTools = parent.session.getActiveToolNames();
		parent.session.sessionManager.appendMessage({ role: "user", content: "PRIVATE PARENT HISTORY", timestamp: Date.now() });
		captured.options.length = 0;
		try {
			const result = await run("inherited", { toolSetup: parent.setup });
			expect(result.errorMessage).toBe("offline prompt boundary");
			expect(snapshots.get("inherited")?.tools).toEqual(["codemode", "extra", "read"]);
			expect(snapshots.get("inherited")?.messages).toBe(0);
			expect(snapshots.get("inherited")?.prompt).not.toContain("PRIVATE PARENT HISTORY");
			expect(captured.options[0].settingsManager?.getSettings().codemode?.mode).toBe("only");
			expect(parent.session.getActiveToolNames()).toEqual(parentTools);
			expect(parent.session.systemPrompt).toBe(parentPrompt);
		} finally { await parent.close(); }
	});

	it("executes inherited codemode against child-local extension tools", async () => {
		const local = join(root, "local-counter.js");
		writeFileSync(local, `export default function(pi) {
			let count = 0;
			pi.registerTool({ name: "counter", label: "counter", description: "child-local counter",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: String(++count) }], details: {} }) });
		}`);
		const parent = await parentSetup({ paths: [local], active: ["codemode", "counter"] });
		try {
			toolConversation("codemode", { code: "text('counter-first=' + await tools.counter({})); text('counter-second=' + await tools.counter({}));" }, (text) => {
				expect(text).toContain("Script completed");
				expect(text).toContain("counter-first=1");
				expect(text).toContain("counter-second=2");
			});
			const results = await Promise.all(["first counter", "second counter"].map((task) => run(task, { toolSetup: parent.setup })));
			for (const result of results) expect(result.status, result.errorMessage).toBe("succeeded");
		} finally { await parent.close(); }
	});

	it("preserves codemode disabled despite child startup activation", async () => {
		const activate = join(root, "activate-codemode.js");
		writeFileSync(activate, `export default function(pi) {
			pi.registerTool({ name: "trigger", label: "trigger", description: "trigger", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
			pi.on("session_start", () => pi.setActiveTools(["read", "trigger", "codemode"]));
		}`);
		const parent = await parentSetup({ paths: [activate], active: ["read", "trigger"] });
		try {
			const result = await run("disabled codemode", { toolSetup: parent.setup });
			expect(result.errorMessage).toBe("offline prompt boundary");
			expect(snapshots.get("disabled codemode")?.tools).toEqual(["read", "trigger"]);
			expect(parent.session.getActiveToolNames()).toEqual(["read", "trigger"]);
		} finally { await parent.close(); }
	});

	it.each([["read"], []])("enforces explicit selection %j against the parent's registry", async (...names) => {
		const parent = await parentSetup();
		try {
			const tools = names as string[];
			const result = await run("explicit inherited", { toolSetup: parent.setup, tools });
			expect(result.errorMessage).toBe("offline prompt boundary");
			expect(snapshots.get("explicit inherited")?.tools).toEqual(tools);
		} finally { await parent.close(); }
	});

	it.each([
		{ tools: ["codemode", "read"] },
		{ tools: ["codemode", "read", "mcp__kept__value"] },
	])("filters deferred and late MCP tools out of nested calls and discovery with $tools", async ({ tools }) => {
		const deferred = join(root, "deferred-tools.js");
		writeFileSync(deferred, `export default function(pi) {
			function register(name) {
				pi.registerTool({ name, label: name, description: name, exposure: "deferred", parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "EXCLUDED TOOL EXECUTED" }], details: {} }) });
			}
			register("deferred_secret");
			register("mcp__kept__value");
			pi.on("tool_call", () => { register("late_secret"); register("mcp__late__secret"); });
		}`);
		const parent = await parentSetup({ paths: [deferred], active: ["read", "codemode"] });
		try {
			toolConversation("codemode", { code: `text(ALL_TOOLS.map(t => t.name));
				for (const name of ["deferred_secret", "late_secret", "mcp__late__secret"]) {
					try { await tools[name]({}); text("UNEXPECTED EXECUTION"); } catch { text("blocked"); }
				}` }, (text) => {
				expect(text).toContain("Script completed");
				expect(text).toContain("read");
				expect(text).not.toContain("secret");
				expect(text).toContain("blocked");
				expect(text).not.toContain("UNEXPECTED EXECUTION");
				expect(text).not.toContain("EXCLUDED TOOL EXECUTED");
			});
			const result = await run("restricted discovery", { toolSetup: parent.setup, tools });
			expect(result.status, result.errorMessage).toBe("succeeded");
		} finally { await parent.close(); }
	});

	it("keeps inherited deferred tools callable without declaring them", async () => {
		const deferred = join(root, "callable-tools.js");
		writeFileSync(deferred, `export default function(pi) {
			pi.registerTool({ name: "deferred_value", label: "value", description: "value", exposure: "deferred",
				parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "inherited deferred value" }], details: {} }) });
		}`);
		const parent = await parentSetup({ paths: [deferred], active: ["codemode"] });
		try {
			toolConversation("codemode", { code: "text(await tools.deferred_value({}));" }, (text) => {
				expect(text).toContain("inherited deferred value");
			});
			const result = await run("inherited deferred", { toolSetup: parent.setup });
			expect(result.status, result.errorMessage).toBe("succeeded");
			expect(snapshots.get("inherited deferred")?.tools).toEqual(["codemode"]);
		} finally { await parent.close(); }
	});

	it.each(["configured", "registered", "registered-on-start"])("reconstructs real asynchronously connected %s MCP tools before verifying contracts", async (mode) => {
		const server = join(root, "mcp-server.cjs");
		writeFileSync(server, `const readline = require("node:readline");
			readline.createInterface({ input: process.stdin }).on("line", line => {
				const message = JSON.parse(line);
				if (message.id === undefined) return;
				let result = {};
				if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
				if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "fixture echo", inputSchema: { type: "object", properties: {} } }] };
				if (message.method === "tools/call") result = { content: [{ type: "text", text: "real MCP child" }] };
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
			});`);
		const config = join(agentDir, "mcp.json");
		const mcpServer = { command: process.execPath, args: [server], exposure: "codemode" as const };
		if (mode === "configured") writeFileSync(config, JSON.stringify({ mcpServers: { fixture: mcpServer } }));
		const owner = join(root, "mcp-owner.js");
		if (mode === "registered-on-start") writeFileSync(owner, `export default function(pi) {
			pi.registerTool({ name: "owner", label: "owner", description: "owner", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
			pi.on("session_start", () => pi.registerMcpServer("fixture", ${JSON.stringify(mcpServer)}));
		}`);
		let parent: Awaited<ReturnType<typeof parentSetup>> | undefined;
		try {
			parent = await parentSetup({ mcp: true, paths: mode === "registered-on-start" ? [owner] : [], active: ["codemode"], mcpServer: mode === "registered" ? mcpServer : undefined });
			toolConversation("codemode", { code: "text(await tools.mcp__fixture__echo({}));" }, (text) => {
				expect(text).toContain("real MCP child");
			});
			const result = await run("real MCP", { toolSetup: parent.setup });
			expect(result.status, result.errorMessage).toBe("succeeded");
		} finally {
			await parent?.close();
			rmSync(config, { force: true });
		}
	});

	it("rejects unreconstructable and changed contracts before prompting", async () => {
		const parent = await parentSetup();
		try {
			const changed = structuredClone(parent.setup);
			changed.tools.find((tool) => tool.name === "extra")!.description = "runtime-only change";
			const drift = await run("contract drift", { toolSetup: changed });
			expect(drift.errorMessage).toContain("extra: contract/source differs");
			const synthetic = structuredClone(parent.setup);
			synthetic.tools.find((tool) => tool.name === "extra")!.sourceInfo.path = "<sdk:extra>";
			const unsupported = await run("synthetic source", { toolSetup: synthetic });
			expect(unsupported.errorMessage).toContain("a loadable extension source is required");
			const unknown = await run("unknown inherited", { toolSetup: parent.setup, tools: ["nonexistent"] });
			expect(unknown.errorMessage).toContain("Unknown child tools");
			expect(snapshots.size).toBe(0);
		} finally { await parent.close(); }
	});

	it("captures one setup per batch and leaves siblings and parent independently configured", async () => {
		const parent = await parentSetup();
		const getAllTools = vi.fn(parent.api.getAllTools!);
		const definition = await registeredTool({ ...parent.api, getAllTools });
		try {
			await definition.execute("batch", { tasks: ["sibling a", "sibling b"] }, undefined, undefined, {
				cwd, model, isProjectTrusted: () => true,
				sessionManager: { getSessionFile: () => undefined },
			} as unknown as ExtensionToolContext);
			expect(getAllTools).toHaveBeenCalledOnce();
			for (const task of ["sibling a", "sibling b"]) {
				expect(snapshots.get(task)?.tools).toEqual(["codemode", "extra", "read"]);
				expect(snapshots.get(task)?.messages).toBe(0);
			}
			expect(snapshots.get("sibling a")?.sessionFile).not.toBe(snapshots.get("sibling b")?.sessionFile);
			expect(parent.session.getActiveToolNames()).toEqual(["read", "extra", "codemode"]);
		} finally { await parent.close(); }
	});

	it("blocks disabled codemode even when an extension reactivates it during a turn", async () => {
		const late = join(root, "late-activation.js");
		writeFileSync(late, `export default function(pi) {
			pi.registerTool({ name: "trigger", label: "trigger", description: "trigger", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
			pi.on("context_with_system", () => { pi.setActiveTools(["trigger", "codemode"]); });
		}`);
		const parent = await parentSetup({ paths: [late], active: ["trigger"] });
		try {
			toolConversation("codemode", { code: "text('SHOULD NOT EXECUTE');" }, (text) => {
				expect(text).toMatch(/outside this child's tool selection|Tool codemode not found/);
				expect(text).not.toContain("Script completed");
				expect(text).not.toContain("SHOULD NOT EXECUTE");
			});
			const result = await run("disabled execution", { toolSetup: parent.setup });
			expect(result.status, result.errorMessage).toBe("succeeded");
		} finally { await parent.close(); }
	});

	it("cancels inherited sessions and emits child shutdown without shutting down the parent", async () => {
		const marker = join(root, "inherited-shutdown.txt");
		const cleanup = join(root, "inherited-cleanup.js");
		writeFileSync(cleanup, `import { appendFileSync } from "node:fs";
			export default function(pi) {
				pi.registerTool({ name: "cleanup", label: "cleanup", description: "cleanup", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) });
				pi.on("session_shutdown", (_event, ctx) => appendFileSync(${JSON.stringify(marker)}, ctx.sessionManager.getSessionId() + "\\n"));
			}`);
		const parent = await parentSetup({ paths: [cleanup], active: ["read", "cleanup"] });
		const controller = new AbortController();
		let started = () => {};
		const ready = new Promise<void>((resolve) => { started = resolve; });
		captured.stream = (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: answer("") });
			options?.signal?.addEventListener("abort", () => {
				stream.push({ type: "error", reason: "aborted", error: answer("", { stopReason: "aborted" }) });
			}, { once: true });
			started();
			return stream;
		};
		try {
			const pending = runSubagent({ cwd, model, thinkingLevel: "off", task: "inherited cancellation", toolSetup: parent.setup, signal: controller.signal, onProgress: () => {} });
			await ready;
			controller.abort();
			const result = await pending;
			expect(result.stopReason).toBe("aborted");
			expect(readFileSync(marker, "utf8").trim()).toBe(result.sessionId);
			expect(parent.session.getActiveToolNames()).toEqual(["read", "cleanup"]);
		} finally { await parent.close(); }
	});

	it("publishes delegation guidance in the model-facing contract", async () => {
		const definition = await registeredTool();
		const guidance = JSON.stringify({ description: definition.description, parameters: definition.parameters, guidelines: definition.promptGuidelines });
		for (const phrase of ["objective", "relevant context", "work mode", "evidence", "verification", "uncertainty", "unseen parent messages"]) {
			expect(guidance.toLowerCase()).toContain(phrase);
		}
		expect(definition.parameters).not.toHaveProperty("properties.skills");
		expect(guidance).toContain("Children choose relevant skills themselves");
	});
});

it.runIf(process.env.PI_SUBAGENT_SMOKE === "1")("smoke-tests installed FFF, Zig-search and unified-edit in sibling children", async () => {
	const configured = JSON.parse(readFileSync(resolve("settings.json"), "utf8"));
	const editing = configured.extensions.find((path: string) => path.endsWith("/unified-edit.ts"));
	expect(editing).toBeTruthy();
	const paths = [resolve("npm/node_modules/@ff-labs/pi-fff/src/index.ts"), resolve("extensions/zig-stdlib-search.ts"), editing];
	const parent = await parentSetup({
		paths, active: ["read", "ffgrep", "fffind", "edit", "zig-stdlib-search", "codemode"],
		settings: { ...configured, packages: [], extensions: [] },
	});
	const target = join(cwd, "smoke-target.txt");
	writeFileSync(target, "smoke needle\n");
	try {
		let completions = 0;
		captured.stream = (_model, context) => {
			const stream = createAssistantMessageEventStream();
			const task = context.messages.find((message) => message.role === "user");
			const isEditing = JSON.stringify(task).includes("editing smoke");
			const result = context.messages.findLast((message) => message.role === "toolResult");
			if (!result) {
				const code = isEditing
					? `text(await tools.edit({ text: ${JSON.stringify(`[${target}]\n@REPLACE\n-smoke needle\n+edited needle`)} }));`
					: `text(await tools.fffind({ pattern: "smoke-target" })); text(await tools.ffgrep({ pattern: "needle" })); text(await tools.zig_stdlib_search({ query: "ArrayList", limit: 1 }));`;
				stream.push({ type: "done", reason: "toolUse", message: answer("", { content: [{ type: "toolCall", id: "smoke", name: "codemode", arguments: { code } }], stopReason: "toolUse" }) });
			} else {
				const text = JSON.stringify(result.content);
				expect(text).toContain("Script completed");
				expect(text).not.toContain("Script failed");
				if (!isEditing) {
					expect(text).toContain("smoke-target");
					expect(text).toContain("standard library");
				}
				completions++;
				stream.push({ type: "done", reason: "stop", message: answer("smoke complete") });
			}
			return stream;
		};
		const results = await Promise.all([
			run("search smoke", { toolSetup: parent.setup }),
			run("editing smoke", { toolSetup: parent.setup }),
		]);
		for (const result of results) expect(result.status, result.errorMessage).toBe("succeeded");
		expect(completions).toBe(2);
		expect(readFileSync(target, "utf8")).toBe("edited needle\n");
		// A child shutting down must not destroy the parent's native finder.
		toolConversation("fffind", { pattern: "smoke-target" }, (text) => { expect(text).toContain("smoke-target"); });
		parent.session.agent.streamFunction = captured.stream!;
		await nativePrompt.call(parent.session, "Check search after child shutdown.", { source: "extension" });
	} finally { await parent.close(); }
}, 60_000);
