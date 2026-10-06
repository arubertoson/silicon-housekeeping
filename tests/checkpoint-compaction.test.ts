import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
	buildSessionContext,
	convertToLlm,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionHandler,
	type SessionEntry,
	SessionManager,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type TurnEndEvent,
	type TurnEndEventResult,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import checkpointCompactionExtension from "../extensions/checkpoint-compaction.ts";

// Pi's preparation helper is not a public export. Resolve relative to the installed
// package for these integration tests instead of reimplementing cut selection.
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
	prepareCompaction(entries: SessionEntry[], settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }): SessionBeforeCompactEvent["preparation"] | undefined;
};

const roots: string[] = [];
type AssistantMessage = Extract<Parameters<SessionManager["appendMessage"]>[0], { role: "assistant" }>;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const usage = {
	input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Representative extractor output for an agreed investigation, not a simulated
// semantic model. These tests exercise the hook, persistence and Pi's real projection.
function continuation() {
	return {
		anchor: {
			objective: "Diagnose the intermittent parser failure.",
			expectedOutcome: "An evidenced diagnosis and proposed fix, without editing yet.",
			constraints: ["Do not add dependencies.", "Do not edit code or write tests before approval."],
			authority: "Investigation only; await explicit implementation approval.",
		},
		outcomes: [
			"Rejected replacing the parser: it breaks the compatibility requirement.",
			"The earlier parser test passed on commit abc123 before uncommitted edits; no fresh test was run.",
		],
		currentState: "Current hypothesis: chunk boundaries split UTF-8 input; observed failure in the streaming case.",
		nextStep: { kind: "await-approval", action: "Await approval of the streaming-parser fix; do not implement yet." },
		uncertainty: ["It is not yet known whether the uncommitted changes pass tests."],
		relevantFiles: ["src/parser.ts"],
	};
}

function assistant(text: string, tool = false): AssistantMessage {
	return {
		role: "assistant" as const,
		content: [
			{ type: "thinking" as const, thinking: "Visible reasoning summary: compatibility rules out replacement." },
			{ type: "text" as const, text },
			...(tool ? [{ type: "toolCall" as const, id: "read-1", name: "read", arguments: { path: "src/parser.ts" } }] : []),
		],
		api: "openai-responses", provider: "test", model: "test", usage,
		stopReason: tool ? "toolUse" as const : "stop" as const, timestamp: 1,
	};
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-compaction-"));
	roots.push(root);
	const session = SessionManager.create(root, root);
	session.appendMessage({ role: "user", content: "Diagnose the parser. No dependencies or edits before approval. " + "old transcript ".repeat(300), timestamp: 1 });
	const common = session.appendMessage(assistant("Replacement would violate compatibility."));
	session.appendMessage({ role: "user", content: "Investigate streaming input.", timestamp: 2 });
	const call = session.appendMessage(assistant("Checking the chunk-boundary hypothesis. " + "recent context ".repeat(100), true));
	const result = session.appendMessage({
		role: "toolResult", toolCallId: "read-1", toolName: "read",
		content: [{ type: "text", text: "Current parser source snapshot; not evidence of past verification." }],
		isError: false, timestamp: 3,
	});
	session.appendMessage(assistant("Awaiting approval of the streaming-parser fix."));

	let hook: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
	let boundaryHook: ExtensionHandler<TurnEndEvent, TurnEndEventResult>;
	let policy: unknown = { triggerTokens: 100_000, rebuiltContextTokens: 16_000 };
	let tokens: number | null = null;
	checkpointCompactionExtension({
		on: (name: string, handler: unknown) => {
			if (name === "session_before_compact") hook = handler as typeof hook;
			if (name === "turn_end") boundaryHook = handler as typeof boundaryHook;
		},
		getSettings: () => ({ checkpointCompaction: policy }),
	} as unknown as ExtensionAPI);
	let draft: unknown = continuation();
	let stopReason = "stop";
	let onExtract = () => {};
	const streamSimple = vi.fn(() => ({ result: async () => {
		onExtract();
		return { stopReason, content: [{ type: "text", text: JSON.stringify(draft) }], usage };
	} }));
	const notify = vi.fn();
	const ctx = {
		cwd: root, mode: "json", sessionManager: session, getContextUsage: () => ({ tokens }),
		model: { maxTokens: 16_384, contextWindow: 1_000_000 }, thinkingLevel: "off",
		modelRegistry: { streamSimple }, ui: { notify },
	} as unknown as ExtensionContext;
	const invoke = async (signal = new AbortController().signal, reason: SessionBeforeCompactEvent["reason"] = "manual") => {
		const branchEntries = session.getBranch();
		const preparation = prepareCompaction(branchEntries, { enabled: true, reserveTokens: 4096, keepRecentTokens: 200 })!;
		expect(preparation).toBeDefined();
		const before = session.getBranch();
		const response = await hook({ type: "session_before_compact", branchEntries, preparation, signal, reason, willRetry: reason === "overflow", customInstructions: "Preserve the no-dependencies agreement." }, ctx) || {};
		return { response, preparation, before };
	};
	const invokeBoundary = async (pending: TurnEndEvent["context"]["pendingMessages"] = [], signal?: AbortSignal) => {
		ctx.signal = signal;
		const branch = session.getBranch();
		const lastAssistant = branch.findLast((entry) => entry.type === "message" && entry.message.role === "assistant")!;
		if (lastAssistant.type !== "message") throw new Error("Missing assistant message");
		const projection = session.buildSessionProjection();
		return await boundaryHook({
			type: "turn_end", turnIndex: 1, outcome: "completed", message: lastAssistant.message,
			messageEntryId: lastAssistant.id, toolResults: [], toolResultEntryIds: [], entries: [], continue: false,
			context: { contextEntries: projection.entries, contextMessages: projection.messages,
				llmMessages: convertToLlm(projection.messages), pendingMessages: pending, canContinue: true },
		}, ctx) || {};
	};
	const persistBoundary = (response: TurnEndEventResult) => {
		const checkpoint = response.entries?.find((entry) => entry.type === "compaction");
		if (!checkpoint || checkpoint.type !== "compaction") throw new Error("Missing checkpoint");
		return session.appendCompaction(checkpoint.summary, checkpoint.firstKeptEntryId, 0, checkpoint.details, true, checkpoint.usage);
	};
	const persist = (response: SessionBeforeCompactResult | void) => {
		if (!response || !response.compaction) throw new Error("Expected valid compaction");
		const c = response.compaction;
		return session.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
	};
	const input = () => streamSimple.mock.calls.at(-1) as unknown as [unknown, { systemPrompt: string; messages: { content: string }[] }, { signal: AbortSignal; cacheRetention: string; sessionId: string; maxTokens: number }];
	return { session, root, common, call, result, invoke, persist, invokeBoundary, persistBoundary, input, streamSimple, notify,
		setPolicy: (value: unknown) => { policy = value; }, setTokens: (value: number) => { tokens = value; },
		setDraft: (value: unknown) => { draft = value; },
		setStop: (value: string) => { stopReason = value; },
		onExtract: (fn: () => void) => { onExtract = fn; },
	};
}

function projected(session: SessionManager) {
	return serializeConversation(convertToLlm(buildSessionContext(session.getBranch()).messages));
}

describe("checkpoint-informed in-place compaction", () => {
	it("materializes all continuation layers after persistence and preserves a split turn's tool pair", async () => {
		const s = setup();
		const { response, preparation, before } = await s.invoke();
		expect(preparation.isSplitTurn).toBe(true);
		expect(response?.compaction?.firstKeptEntryId).toBe(preparation.firstKeptEntryId);
		expect(s.session.getBranch()).toEqual(before); // No speculative state entries or new session.
		s.persist(response);
		const reopened = SessionManager.open(s.session.getSessionFile()!);
		const context = projected(reopened);
		const state = continuation();
		for (const text of [state.anchor.objective, state.anchor.expectedOutcome, state.anchor.authority,
			...state.anchor.constraints, ...state.outcomes, state.currentState, state.nextStep.action,
			...state.uncertainty, ...state.relevantFiles]) expect(context).toContain(text);
		expect(context).not.toContain("old transcript");
		expect(context).toContain("Awaiting approval of the streaming-parser fix.");
		const kept = reopened.buildSessionContext().messages;
		expect(kept).toContainEqual(expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "toolCall", id: "read-1" })]) }));
		expect(kept).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "read-1" }));
		expect(reopened.getLeafEntry()).toMatchObject({ type: "compaction", usage, details: { version: 1 } });
		expect(s.notify).not.toHaveBeenCalled();
	});

	it("uses projected evidence and visible reasoning, not omitted entries, raw snapshots, or system declarations", async () => {
		const s = setup();
		const removed = s.session.appendMessage({ role: "user", content: "OMITTED request to replace parser", timestamp: 4 });
		s.session.appendContextEdit(removed, null);
		const corrected = s.session.appendMessage({ role: "user", content: "RETRACTED direction", timestamp: 5 });
		s.session.appendContextEdit(corrected, { content: "Only investigate; wait for approval." });
		s.session.appendMessage({ role: "system", content: "SECRET system declaration", timestamp: 5 });
		await s.invoke();
		const [, input, options] = s.input();
		expect(input.messages[0].content).not.toMatch(/OMITTED|RETRACTED|SECRET/);
		expect(input.messages[0].content).toContain("Only investigate; wait for approval.");
		expect(input.messages[0].content).toContain("Visible reasoning summary");
		expect(input.systemPrompt).toContain("Do not introduce a first-reply summary, a wait gate, or a one-increment limit unless already agreed");
		expect(options.cacheRetention).toBe("none");
	});

	it("reconciles subsequent epochs from saved ancestry and ignores abandoned branch state", async () => {
		const s = setup();
		s.persist((await s.invoke()).response);
		const first = s.session.getLeafId()!;
		s.session.appendMessage({ role: "user", content: "Implementation is now approved. " + "new context ".repeat(100), timestamp: 6 });
		const abandoned = continuation();
		abandoned.anchor.objective = "ABANDONED objective";
		s.setDraft(abandoned);
		s.persist((await s.invoke()).response);
		s.session.branch(first);
		s.session.appendMessage({ role: "user", content: "Keep investigation-only scope. " + "new context ".repeat(100), timestamp: 7 });
		s.setDraft(continuation());
		s.persist((await s.invoke()).response);
		const evidence = s.input()[1].messages[0].content;
		expect(evidence).toContain(JSON.stringify(continuation()));
		expect(evidence).not.toContain("ABANDONED");
		expect(evidence).not.toContain("Implementation is now approved.");
		expect(projected(s.session)).toContain("Investigation only; await explicit implementation approval.");
		// Navigating before any checkpoint must not resurrect state from another branch.
		s.session.branch(s.common);
		s.session.appendMessage({ role: "user", content: "Different investigation branch. " + "tail ".repeat(300), timestamp: 8 });
		await s.invoke();
		expect(s.input()[1].messages[0].content).toContain("Previous structured continuation:\nnull");
	});

	it("keeps an external goal canonical without sending changing budget counters or creating a goal", async () => {
		const s = setup();
		s.session.appendCustomEntry("goal", { version: 2, action: "account", goal: {
			id: "goal-1", objective: "Canonical external objective", status: "paused", tokensUsed: 987654321,
		} });
		s.persist((await s.invoke()).response);
		expect(projected(s.session)).toContain("Objective: Canonical external objective");
		expect(projected(s.session)).not.toContain(`Objective: ${continuation().anchor.objective}`);
		// The adapter sends only canonical identity, intent and status, not usage state.
		expect(s.input()[1].messages[0].content).not.toContain("987654321");
		expect(s.session.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
		s.session.appendCustomEntry("goal", { version: 2, action: "clear", goal: null });
		s.session.appendMessage({ role: "user", content: "Continue the investigation. " + "new context ".repeat(100), timestamp: 8 });
		await s.invoke();
		expect(s.input()[1].messages[0].content).toContain("Canonical goal (if present; status is not authorization):\nnull");
	});

	it.each(["manual", "overflow"] as const)("preserves autonomous authority during %s compaction without introducing a gate", async (reason) => {
		const s = setup();
		const state = continuation();
		state.anchor.authority = "Implement and verify autonomously within the agreed scope.";
		state.anchor.constraints = ["No dependency changes."];
		state.nextStep = { kind: "implement", action: "Fix the streaming decoder within the agreed scope." };
		s.setDraft(state);
		s.persist((await s.invoke(undefined, reason)).response);
		expect(projected(s.session)).toContain(state.anchor.authority);
		expect(projected(s.session)).not.toMatch(/first reply|then wait|one increment/i);
	});

	it.each(["normal", "Pi auto off", "large tool batch", "overflow recovery", "completed reply", "goal metadata", "proposed message"])("applies checkpoint compaction through the real agent scheduler: %s", async (scenario) => {
		const s = setup();
		const runtime = await ModelRuntime.create({
			authPath: join(s.root, "auth.json"), modelsPath: null,
			modelsStorePath: join(s.root, "models-cache.json"), refreshOnCreate: false,
		});
		const requests: string[] = [];
		let mainCalls = 0;
		const state = continuation();
		state.anchor.authority = "Implement and verify autonomously within the agreed scope.";
		state.anchor.constraints = ["No dependency changes."];
		state.nextStep = { kind: "implement", action: "Finish the agreed parser fix." };
		if (scenario === "completed reply") state.nextStep = { kind: "report-completion", action: "Report completion; no further work is authorized." };
		const extractionRequests: string[] = [];
		runtime.registerProvider("test", {
			api: "openai-responses", apiKey: "offline", baseUrl: "https://example.invalid",
			models: [{ id: "test", name: "Offline fixture provider", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20_000, maxTokens: 8192 }],
			streamSimple: (_model, context) => {
				const request = JSON.stringify(context);
				const extracting = request.includes("Extract accepted continuation state for in-place compaction");
				if (!extracting) requests.push(request);
				else extractionRequests.push(request);
				const response = assistant(extracting ? JSON.stringify(state) : "Completed the permitted increment.");
				response.timestamp = Date.now();
				if (!extracting && mainCalls++ === 0) {
					// Cross OUR 5K trigger, below Pi's ordinary 15,904-token trigger.
					response.usage = { ...usage, input: 7000, totalTokens: 7050 };
					if (scenario === "overflow recovery") {
						response.stopReason = "error";
						response.errorMessage = "context_length_exceeded";
					} else if (scenario !== "completed reply") {
						response.content = [{ type: "toolCall", id: "observe-1", name: "observe", arguments: {} }];
						response.stopReason = "toolUse";
					}
				}
				// A small offline provider stream; all compaction and agent scheduling
				// below use the actual Pi runtime, not a simulated continuation loop.
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: { ...response, stopReason: "pending" } };
						yield { type: "done", reason: response.stopReason, message: response };
					},
					result: async () => response,
				} as unknown as ReturnType<ExtensionContext["modelRegistry"]["streamSimple"]>;
			},
		});
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: scenario !== "Pi auto off", reserveTokens: 4096, keepRecentTokens: 200 },
			checkpointCompaction: { triggerTokens: 5000, rebuiltContextTokens: 3000 },
		} as Parameters<typeof SettingsManager.inMemory>[0]);
		const precedingExtension = (pi: ExtensionAPI) => {
			if (scenario === "goal metadata") pi.on("turn_end", (event) => ({ entries: [...event.entries, {
				type: "custom", customType: "goal", data: { version: 2, action: "account",
					goal: { id: "goal-1", objective: "Canonical external objective", status: "active", tokensUsed: 987654321 } },
			}] }));
			if (scenario === "proposed message") pi.on("turn_end", (event) => ({ entries: [...event.entries, {
				type: "custom_message", customType: "boundary-instruction", display: false, content: "Boundary instruction: no dependency changes.",
			}] }));
		};
		const loader = new DefaultResourceLoader({
			cwd: s.root, agentDir: s.root, settingsManager, extensionFactories: [precedingExtension, checkpointCompactionExtension],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Offline compaction integration test.",
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: s.root, agentDir: s.root, modelRuntime: runtime, model: runtime.getModel("test", "test"),
			thinkingLevel: "off", settingsManager, sessionManager: s.session, resourceLoader: loader,
			tools: ["observe"], customTools: [{ name: "observe", label: "Observe", description: "Return a small observation.",
				parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: scenario === "large tool batch" ? "Large observation ".repeat(10_000) : "Observation complete." }], details: undefined }) }],
		});
		try {
			await session.bindExtensions({});
			await session.prompt("Continue implementing within the existing authority.");
			expect(requests).toHaveLength(scenario === "completed reply" ? 1 : 2);
			expect(extractionRequests).toHaveLength(1);
			if (scenario !== "completed reply") {
				expect(requests[1]).toContain(state.anchor.authority);
				expect(requests[1]).toContain(state.nextStep.action);
			}
			const checkpoints = s.session.getBranch().filter((entry) => entry.type === "compaction");
			expect(checkpoints).toHaveLength(1);
			expect(checkpoints[0]).toMatchObject({ details: { estimatedTokensAfter: expect.any(Number) } });
			if (checkpoints[0].type === "compaction") {
				expect((checkpoints[0].details as { estimatedTokensAfter: number }).estimatedTokensAfter).toBeLessThanOrEqual(3000);
			}
			if (scenario === "large tool batch") expect(projected(s.session)).not.toContain("Large observation");
			if (scenario === "goal metadata") {
				expect(requests[1]).toContain("Canonical external objective");
				expect(extractionRequests[0]).not.toContain("987654321");
			}
			if (scenario === "proposed message") expect(requests[1]).toContain("Boundary instruction: no dependency changes.");
			expect(session.getLastAssistantText()).toBe("Completed the permitted increment.");
		} finally { session.dispose(); }
	});

	it("uses queued messages as extraction evidence without copying them into the checkpoint", async () => {
		const s = setup();
		s.setTokens(100_001);
		const queued = [{ role: "user" as const, content: "Queued request: preserve the active parser compatibility constraint.", timestamp: 10 }];
		const response = await s.invokeBoundary(queued);
		const extraction = s.input()[1].messages[0].content;
		expect(extraction).toContain("Queued request: preserve the active parser compatibility constraint.");
		expect(extraction).toContain("evidence for reconciling the checkpoint only");
		s.persistBoundary(response);
		const checkpoint = s.session.getLeafEntry();
		expect(checkpoint).toMatchObject({ type: "compaction" });
		if (checkpoint?.type === "compaction") {
			expect(checkpoint.summary).not.toContain("Queued request: preserve the active parser compatibility constraint.");
		}
		expect(s.session.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user" &&
			JSON.stringify(entry.message.content).includes("Queued request: preserve the active parser compatibility constraint."))).toBe(false);
	});

	it("checks each completed boundary without extracting below threshold or requesting continuation", async () => {
		const s = setup();
		s.setTokens(99_999);
		expect(await s.invokeBoundary()).toEqual({});
		expect(s.streamSimple).not.toHaveBeenCalled();
		s.setTokens(100_000);
		const before = s.session.getBranch();
		const response = await s.invokeBoundary();
		expect(response.continue).toBeUndefined();
		expect(s.session.getBranch()).toEqual(before);
		s.persistBoundary(response);
		expect(projected(s.session)).toContain(continuation().nextStep.action);
		expect(s.streamSimple).toHaveBeenCalledOnce();
	});

	it("suppresses only Pi's ordinary threshold trigger, not its overflow or manual workflow", async () => {
		const s = setup();
		expect((await s.invoke(undefined, "threshold")).response).toEqual({ cancel: true });
		expect(s.streamSimple).not.toHaveBeenCalled();
		expect((await s.invoke(undefined, "overflow")).response.compaction).toBeDefined();
	});

	it("budgets current prompt/tool declarations and pending messages before extraction", async () => {
		const s = setup();
		s.setPolicy({ triggerTokens: 5000, rebuiltContextTokens: 2500 });
		s.setTokens(7000);
		s.session.appendMessage({ role: "system", content: "Active instructions. ".repeat(100),
			toolsAdded: [{ name: "wide-schema", description: "Tool declaration. ".repeat(100), parameters: Type.Object({}) }], timestamp: 2 });
		const pending = [{ role: "user" as const, content: "Queued steering. ".repeat(20), timestamp: 3 }];
		const response = await s.invokeBoundary(pending);
		expect(s.notify).not.toHaveBeenCalled();
		expect(s.input()[2].maxTokens).toBeLessThan(1000);
		s.persistBoundary(response);
		const checkpoint = s.session.getLeafEntry();
		expect(checkpoint).toMatchObject({ type: "compaction", systemMessage: { toolsAdded: [expect.objectContaining({ name: "wide-schema" })] } });
		if (checkpoint?.type === "compaction") expect((checkpoint.details as { estimatedTokensAfter: number }).estimatedTokensAfter).toBeLessThanOrEqual(2500);
	});

	it("counts the effective system/tool checkpoint, not superseded declarations", async () => {
		const s = setup();
		s.setPolicy({ triggerTokens: 5000, rebuiltContextTokens: 2000 });
		s.setTokens(7000);
		s.session.appendMessage({ role: "system", content: "", sections: { guidelines: "Obsolete guidelines ".repeat(5000) },
			toolsAdded: [{ name: "obsolete", description: "Obsolete tool ".repeat(5000), parameters: Type.Object({}) }], timestamp: 3 });
		s.session.appendMessage({ role: "system", content: "", sections: { guidelines: "Current mandatory guidelines." }, toolsRemoved: [{ name: "obsolete" }], timestamp: 4 });
		const response = await s.invokeBoundary();
		expect(s.notify).not.toHaveBeenCalled();
		s.persistBoundary(response);
		const checkpoint = s.session.getLeafEntry();
		expect(checkpoint).toMatchObject({ type: "compaction", systemMessage: { sections: { guidelines: "Current mandatory guidelines." } } });
		if (checkpoint?.type === "compaction") expect(checkpoint.systemMessage?.toolsAdded ?? []).toEqual([]);
	});

	it("rejects a trigger outside the selected model's context window before extraction", async () => {
		const s = setup();
		s.setPolicy({ triggerTokens: 1_000_000, rebuiltContextTokens: 16_000 });
		s.setTokens(1_000_001);
		expect(await s.invokeBoundary()).toEqual({});
		expect(s.streamSimple).not.toHaveBeenCalled();
		expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("context window"), "error");
	});

	it("drops an oversized completed tool batch atomically rather than retaining orphan results", async () => {
		const s = setup();
		s.session.branch(s.call);
		s.session.appendMessage({ role: "toolResult", toolCallId: "read-1", toolName: "read",
			content: [{ type: "text", text: "Oversized snapshot ".repeat(10_000) }], isError: false, timestamp: 3 });
		s.setPolicy({ triggerTokens: 5000, rebuiltContextTokens: 2000 });
		const response = await s.invokeBoundary();
		expect(response.entries).toContainEqual(expect.objectContaining({ type: "compaction", firstKeptEntryId: null }));
		s.persistBoundary(response);
		const messages = s.session.buildSessionContext().messages;
		expect(messages.some((message) => message.role === "toolResult" || message.role === "assistant")).toBe(false);
		expect(projected(s.session)).toContain(continuation().currentState);
	});

	it.each(["system overhead", "pending overhead", "checkpoint too large"])("reports an infeasible budget without changing context: %s", async (failure) => {
		const s = setup();
		s.setTokens(100_001);
		if (failure === "system overhead") s.session.appendMessage({ role: "system", content: "Mandatory instruction ".repeat(4000), timestamp: 3 });
		const pending = failure === "pending overhead" ? [{ role: "user" as const, content: "Queued message ".repeat(5000), timestamp: 4 }] : [];
		if (failure === "checkpoint too large") {
			const state = continuation();
			state.anchor.constraints.push("An essential prohibition ".repeat(3000));
			s.setDraft(state);
		}
		const before = s.session.getBranch();
		expect(await s.invokeBoundary(pending)).toEqual({});
		expect(s.session.getBranch()).toEqual(before);
		expect(s.notify).toHaveBeenCalledWith(expect.stringMatching(/budget/i), "error");
		if (failure !== "checkpoint too large") expect(s.streamSimple).not.toHaveBeenCalled();
	});

	it.each([undefined, { triggerTokens: 1000, rebuiltContextTokens: 2000 }, { triggerTokens: 5000, rebuiltContextTokens: 0 }, { triggerTokens: 5000.5, rebuiltContextTokens: 2000 }])("requires explicit, valid policy settings: %j", async (policy) => {
		const s = setup();
		s.setPolicy(policy);
		s.setTokens(100_001);
		expect(await s.invokeBoundary()).toEqual({});
		expect(s.streamSimple).not.toHaveBeenCalled();
		if (policy === undefined) expect(s.notify).not.toHaveBeenCalled();
		else expect(s.notify).toHaveBeenCalledOnce();
	});

	it("does not save a boundary checkpoint after cancellation or branch mutation", async () => {
		for (const mutation of ["abort", "branch"] as const) {
			const s = setup();
			s.setTokens(100_001);
			const abort = new AbortController();
			s.onExtract(() => { if (mutation === "abort") abort.abort(); else s.session.branch(s.common); });
			expect(await s.invokeBoundary([], abort.signal)).toEqual({});
			expect(s.session.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			if (mutation === "abort") expect(s.notify).not.toHaveBeenCalled();
			else expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("Session changed"), "error");
		}
	});

	it("records completion rather than inventing implementation work", async () => {
		const s = setup();
		const state = continuation();
		state.currentState = "The diagnosis and proposed fix have been delivered.";
		state.nextStep = { kind: "report-completion", action: "Report completion; no further work is authorized." };
		s.setDraft(state);
		s.persist((await s.invoke()).response);
		expect(projected(s.session)).toContain("Immediate next step (report-completion)");
		expect(projected(s.session)).toContain(state.nextStep.action);
	});

	it.each(["missing next step", "blank expected outcome", "partial response", "session changed", "aborted", "bad goal"])("cancels %s extraction without falling back or persisting speculative state", async (failure) => {
		const s = setup();
		const controller = new AbortController();
		const state = continuation();
		if (failure === "missing next step") { const { nextStep: _, ...incomplete } = state; s.setDraft(incomplete); }
		if (failure === "blank expected outcome") { state.anchor.expectedOutcome = "  "; s.setDraft(state); }
		if (failure === "partial response") s.setStop("length");
		if (failure === "session changed") s.onExtract(() => s.session.appendCustomEntry("changed", {}));
		if (failure === "aborted") s.onExtract(() => controller.abort());
		if (failure === "bad goal") s.session.appendCustomEntry("goal", { goal: { objective: "Incomplete canonical state" } });
		const { response } = await s.invoke(controller.signal);
		expect(response).toEqual({ cancel: true });
		expect(s.session.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		if (failure === "aborted") expect(s.notify).not.toHaveBeenCalled();
		else expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("Checkpoint compaction stopped:"), "error");
	});
});
