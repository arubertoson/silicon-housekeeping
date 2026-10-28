// Runner regressions adapted from pasky/pi-amplike; the retained MIT licence
// and adoption provenance are in ../extensions/subagent.ts.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

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
const snapshots = new Map<string, {
	tools: string[];
	skills: string[];
	prompt: string;
	messages: number;
	model: string | undefined;
	thinking: string;
	sessionFile: string | undefined;
}>();

async function registeredTool(): Promise<ToolDefinition> {
	const { default: register } = await import("../extensions/subagent.js");
	let definition: ToolDefinition | undefined;
	register({
		registerTool: (tool: ToolDefinition) => { definition = tool; },
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	if (!definition) throw new Error("subagent tool not registered");
	return definition;
}

function skill(path: string, name: string) {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Test ${name} skill\n---\nPRIVATE SKILL BODY\n`);
}

async function run(task: string, lists: { tools?: string[]; skills?: string[]; extensionPaths?: string[] } = {}) {
	return runSubagent({
		cwd,
		model,
		thinkingLevel: "off",
		task,
		extensionPaths: [extension],
		...lists,
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

	skill(join(agentDir, "skills", "writing"), "writing");
	skill(join(cwd, ".pi", "skills", "research"), "research");
	skill(join(cwd, "external", "custom"), "custom");
	skill(join(cwd, "external", "extension-skill"), "extension-skill");

	extension = join(root, "explicit.js");
	writeFileSync(extension, `export default function (pi) {
		for (const name of ["extra", "other"]) {
			pi.registerTool({ name, label: name, description: name,
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [], details: {} }) });
		}
		pi.on("session_start", () => pi.setActiveTools(["read", "extra", "other", "bash"]));
		pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(join(cwd, "external", "extension-skill"))}] }));
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
			skills: this.resourceLoader.getSkills().skills.map((entry) => entry.name).sort(),
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
});

beforeEach(() => {
	snapshots.clear();
	captured.options.length = 0;
	captured.stream = undefined;
});

afterAll(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("child configuration through the installed Pi SDK", () => {
	it("omission keeps defaults and discovery, fresh context and inherited selection", async () => {
		const result = await run("default");
		expect(result.errorMessage).toBe("offline prompt boundary");
		expect(captured.options[0].tools).toBeUndefined();
		expect(captured.options[0].customTools).toBeUndefined();
		const snapshot = snapshots.get("default")!;
		expect(snapshot.tools).toEqual(["bash", "extra", "other", "read"]);
		expect(snapshot.skills).toEqual(expect.arrayContaining(["writing", "research"]));
		expect(snapshot.messages).toBe(0);
		expect(snapshot.model).toBe(model.id);
		expect(captured.options[0].thinkingLevel).toBe("off");
		// The SDK may clamp the inherited level to the selected model's support.
		expect(snapshot.thinking).toBeTruthy();
		expect(snapshot.sessionFile).toBeTruthy();
	});

	it("uses native defaults without rediscovering parent extensions", async () => {
		const discovered = join(agentDir, "extensions", "must-not-load.js");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(discovered, 'throw new Error("parent extension must not load");');
		try {
			await run("no-extensions", { extensionPaths: [] });
			expect(snapshots.get("no-extensions")?.tools).toEqual(["bash", "edit", "read", "write"]);
		} finally {
			rmSync(join(agentDir, "extensions"), { recursive: true });
		}
	});

	it.each([[["read"]], [[]]])("enforces exact tool list %j", async (tools) => {
		await run("limited", { tools });
		expect(snapshots.get("limited")?.tools).toEqual(tools);
		expect(captured.options[0].customTools).toBeUndefined();
	});

	it("enables only explicitly named extension and non-default built-in tools", async () => {
		await run("extension", { tools: ["extra", "grep"] });
		expect(snapshots.get("extension")?.tools).toEqual(["extra", "grep"]);
	});

	it("uses ordinary SDK bash without an Amp permission override", async () => {
		await run("bash", { tools: ["bash"] });
		expect(snapshots.get("bash")?.tools).toEqual(["bash"]);
		expect(captured.options[0].customTools).toBeUndefined();
	});

	it.each(["not-a-tool", "*", "+read"])("rejects unknown/non-exact tool %s before prompting", async (name) => {
		const result = await run("invalid", { tools: [name] });
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("Unknown child tools");
		expect(snapshots.size).toBe(0);
	});

	it.each([
		[[], []],
		[["writing"], ["writing"]],
		[["extension-skill"], ["extension-skill"]],
		[["./external/custom"], ["custom"]],
		[["external/custom/SKILL.md"], ["custom"]],
	])("selects skills %j using Pi loading", async (skills, expected) => {
		await run("skills", { skills, tools: ["read"] });
		const snapshot = snapshots.get("skills")!;
		expect(snapshot.skills).toEqual(expected);
		expect(snapshot.prompt).not.toContain("PRIVATE SKILL BODY");
		if (expected.length > 0) {
			expect(snapshot.prompt).toContain(`<name>${expected[0]}</name>`);
		}
	});

	it("accepts absolute skill paths", async () => {
		await run("absolute", { skills: [join(cwd, "external", "custom", "SKILL.md")] });
		expect(snapshots.get("absolute")?.skills).toEqual(["custom"]);
	});

	it.each(["missing-name", "./missing/SKILL.md"])("reports missing skill %s before prompting", async (name) => {
		const result = await run("missing", { skills: [name] });
		expect(result.errorMessage).toContain(`Missing skill "${name}"`);
		expect(snapshots.size).toBe(0);
	});

	it("rejects ambiguous names, but accepts an explicit path", async () => {
		const duplicate = join(cwd, ".pi", "skills", "duplicate");
		skill(duplicate, "writing");
		try {
			const result = await run("ambiguous", { skills: ["writing"] });
			expect(result.errorMessage).toContain('Ambiguous skill "writing"');
			expect(snapshots.size).toBe(0);
			await run("explicit", { skills: [join(duplicate, "SKILL.md")] });
			expect(snapshots.get("explicit")?.skills).toEqual(["writing"]);
		} finally {
			rmSync(duplicate, { recursive: true });
		}
	});

	it("passes invocation lists to every child through the existing tool interface", async () => {
		const definition = await registeredTool();
		const context = {
			cwd,
			model,
			modelRegistry: {},
			sessionManager: {
				getSessionFile: () => undefined,
				getBranch: () => { throw new Error("must not read parent conversation"); },
			},
		} as unknown as ExtensionToolContext;
		expect(definition?.parameters).toMatchObject({
			properties: { tools: { type: "array" }, skills: { type: "array" } },
		});
		await definition!.execute("call", { tasks: ["schema-a", "schema-b"], tools: [], skills: [] }, undefined, undefined, context);
		for (const task of ["schema-a", "schema-b"]) {
			expect(snapshots.get(task)?.tools).toEqual([]);
			expect(snapshots.get(task)?.skills).toEqual([]);
			expect(snapshots.get(task)?.model).toBe(model.id);
		}
	});

	it("keeps concurrent child configurations and parent resources independent", async () => {
		const settingsManager = SettingsManager.inMemory({});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			skillsOverride: (base) => ({ ...base, skills: base.skills.filter((entry) => entry.name === "research") }),
		});
		await resourceLoader.reload();
		const { session: parent } = await createAgentSession({
			cwd, agentDir, model, settingsManager, resourceLoader,
			sessionManager: SessionManager.inMemory(cwd), tools: ["read", "write"],
		});
		const parentSkills = parent.resourceLoader.getSkills();
		const parentPrompt = parent.systemPrompt;
		captured.options.length = 0;

		try {
			await Promise.all([
				run("first", { tools: ["read"], skills: ["writing"] }),
				run("second", { tools: [], skills: [] }),
				run("default-child"),
			]);
			expect(snapshots.get("first")?.tools).toEqual(["read"]);
			expect(snapshots.get("first")?.skills).toEqual(["writing"]);
			expect(snapshots.get("second")?.tools).toEqual([]);
			expect(snapshots.get("second")?.skills).toEqual([]);
			expect(snapshots.get("default-child")?.skills).toEqual(expect.arrayContaining(["writing", "research"]));
			expect(parent.getActiveToolNames().sort()).toEqual(["read", "write"]);
			expect(parent.resourceLoader).toBe(resourceLoader);
			expect(parent.resourceLoader.getSkills()).toEqual(parentSkills);
			expect(parent.systemPrompt).toBe(parentPrompt);
			expect(new Set(captured.options.map((options) => options.resourceLoader)).size).toBe(3);
			expect(new Set(captured.options.map((options) => options.settingsManager)).size).toBe(3);
		} finally {
			parent.dispose();
		}
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
			cwd, model, thinkingLevel: "off", task: "native retry", tools: [], skills: [],
			onProgress: (r) => { updates.push(...r.displayItems.filter((i) => i.type === "text").map((i) => i.text)); },
		});
		expect(attempts).toBe(2);
		expect(result.exitCode).toBe(0);
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
			tools: [], skills: [], onProgress: () => { throw new Error("UI unavailable"); },
		});
		await ready;
		controller.abort();
		const result = await pending;
		expect(providerAborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(dispose).toHaveBeenCalledOnce();
	} finally {
		dispose.mockRestore();
	}
});

it("does not create a child when already cancelled", async () => {
	const result = await runSubagent({
		cwd, model, thinkingLevel: "off", task: "already cancelled",
		signal: AbortSignal.abort(), onProgress: () => {},
	});
	expect(result.stopReason).toBe("aborted");
	expect(captured.options).toHaveLength(0);
});

it("emits extension shutdown even when prompt fails", async () => {
	const marker = join(root, "shutdown.txt");
	const cleanup = join(root, "cleanup.js");
	writeFileSync(cleanup, `import { writeFileSync } from "node:fs";
		export default function(pi) {
			pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(marker)}, "closed"));
		}`);
	const result = await run("failure cleanup", { extensionPaths: [cleanup] });
	expect(result.exitCode).toBe(1);
	expect(readFileSync(marker, "utf8")).toBe("closed");
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
		cwd, model, modelRegistry: { find: (provider: string, id: string) => provider === selected.provider && id === selected.id ? selected : undefined },
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
		task: "Review draft", exitCode: 0, finalOutput: "# Answer\n\nA concise result.", agentBadge: "provider/model",
		displayItems: [{ type: "toolCall" as const, name: "read", args: { path: "/tmp/draft.md" } }],
		usage: { ...emptyUsage(), turns: 3, input: 1200 },
	};
	const collapsed = stripVTControlCharacters(renderResults([result], { expanded: false, label: "subagent" }, theme).render(100).join("\n"));
	expect(collapsed).toContain("[provider/model]");
	expect(collapsed).toContain("read /tmp/draft.md");
	expect(collapsed).toContain("3 turns ↑1.2k");
	expect(collapsed).toContain("Ctrl+O to expand");
	const expanded = stripVTControlCharacters(renderResults([result], { expanded: true, label: "subagent" }, theme).render(100).join("\n"));
	expect(expanded).toContain("Answer");
	expect(expanded).toContain("A concise result.");
	expect(expanded).not.toContain("Ctrl+O to expand");
	const running = stripVTControlCharacters(renderResults([{ ...result, exitCode: -1 }], { expanded: true, label: "subagent" }, theme).render(100).join("\n"));
	expect(running).toContain("1 running");
});
