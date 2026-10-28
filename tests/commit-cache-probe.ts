// Opt-in live, read-only probe: PI_COMMIT_CACHE_PROBE=1 node tests/commit-cache-probe.ts
// Sends the saved active branch to the configured provider; never executes returned tools.
import { createHash } from "node:crypto";
import { convertToLlm, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

if (process.env.PI_COMMIT_CACHE_PROBE !== "1") throw new Error("Set PI_COMMIT_CACHE_PROBE=1 to authorize live provider requests.");
const path = process.env.PI_SESSION_FILE;
const provider = process.env.PI_PROVIDER;
const id = process.env.PI_MODEL;
if (!path || !provider || !id) throw new Error("Run inside Pi with PI_SESSION_FILE, PI_PROVIDER and PI_MODEL.");
const runtime = await ModelRuntime.create({ refreshOnCreate: false });
const model = runtime.getModel(provider, id);
if (!model) throw new Error(`Configured model not found: ${provider}/${id}`);
// Ask the SDK to clamp off exactly as /commit does; undefined alone can use a
// provider default rather than the model's lowest supported level.
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), settingsManager, noExtensions: true,
	noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true });
await resourceLoader.reload();
const { session: scratch } = await createAgentSession({ modelRuntime: runtime, model,
	thinkingLevel: "off", settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(), noTools: "all" });
const lowest = scratch.thinkingLevel;
scratch.dispose();
const parent = SessionManager.open(path);
const original = JSON.stringify(parent.getEntries());
const prefix = convertToLlm(structuredClone(parent.buildSessionContext().messages));
const suffix = { role: "user" as const, content: "Read-only cache experiment. Do not use tools or perform any work. Reply only OK.", timestamp: Date.now() };
const baseline = [...prefix, suffix];
const appended = [...baseline, { ...suffix, content: "Disposable /commit-style suffix for cache measurement ONLY. No commit is authorized. Do not use tools. Reply OK." }];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex").slice(0, 16);
const results: unknown[] = [];
for (const [label, reasoning, messages] of [
	["baseline-high", "high", baseline],
	["repeat-high-control", "high", baseline],
	["appended-high-control", "high", appended],
	["clone-lowest-appended", lowest, appended],
	["repeat-lowest-control", lowest, appended],
] as const) {
	let shape: unknown;
	const stream = runtime.streamSimple(model, { messages: structuredClone(messages) }, {
		reasoning: reasoning === "off" ? undefined : reasoning, maxTokens: 512, transport: "sse", cacheRetention: "short",
		sessionId: parent.getSessionId(),
		onPayload(payload) {
			const body = payload as { instructions?: unknown; tools?: unknown; input?: unknown[]; reasoning?: unknown };
			shape = { instructionsHash: hash(body.instructions), toolsHash: hash(body.tools), inputHash: hash(body.input), inputCount: body.input?.length, reasoning: body.reasoning };
		},
	});
	// Drain notifications without running any tool calls or persisting messages/usage.
	for await (const _event of stream) { /* intentionally read-only */ }
	const response = await stream.result();
	if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage ?? response.stopReason);
	const row = { label, provider, model: id, requestedThinking: reasoning, stopReason: response.stopReason, usage: response.usage, payloadShape: shape };
	results.push(row);
	console.log(JSON.stringify(row));
}
if (JSON.stringify(parent.getEntries()) !== original) throw new Error("Probe modified the source manager.");
console.log(JSON.stringify({ savedProjectionPrefixHash: hash(prefix), requests: results.length, parentManagerUnchanged: true,
	limitation: "Measures provider cache usage for the saved projection, not unobservable live extension transformations. Reasoning is provider-clamped; no WebSocket state or transcript writes." }));
