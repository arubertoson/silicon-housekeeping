// Explicit live check, not part of npm test:
// PI_COMPACTION_LIVE=1 PI_COMPACTION_LIVE_MODEL=<model-id> node tests/compaction-live-smoke.ts
// At most two short agent replies and one checkpoint; synthetic context only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, readStoredCredential,
  SessionManager, SettingsManager,
  type AgentSession, type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import { finishAttempt, generateCheckpoint } from "../support/compaction-draft.ts";
import { observePayload, observeRequest } from "../support/compaction-observation.ts";
import { dispose, suspend, type CompactionState } from "../support/compaction-state.ts";

if (process.env.PI_COMPACTION_LIVE !== "1") throw new Error("Set PI_COMPACTION_LIVE=1 to permit provider requests");
const modelId = process.env.PI_COMPACTION_LIVE_MODEL;
if (!modelId) throw new Error("Choose an account-supported PI_COMPACTION_LIVE_MODEL from the local catalog");
let credential = readStoredCredential("openai-codex");
if (!credential) throw new Error("No stored openai-codex credential; no requests made");
if (credential.type === "oauth" && credential.expires < Date.now() + 600_000) {
  throw new Error("Live check requires an already-valid OAuth token; it will not refresh user credentials");
}
// Read credentials once; all store operations remain in memory. Nothing is
// copied into the workspace, and this bounded check never rotates user tokens.
const credentials: NonNullable<CreateModelRuntimeOptions["credentials"]> = {
  async read(provider) { return provider === "openai-codex" ? credential : undefined; },
  async list() { return credential ? [{ providerId: "openai-codex", type: credential.type }] : []; },
  async modify(provider, update) {
    if (provider !== "openai-codex") return undefined;
    credential = await update(credential) ?? credential;
    return credential;
  },
  async delete(provider) { if (provider === "openai-codex") credential = undefined; },
};

const root = await mkdtemp(join(tmpdir(), "pi-compaction-live-"));
const state: CompactionState = { generation: 0 };
let session: AgentSession | undefined;
const deadline = setTimeout(() => {
  state.attempt?.controller.abort();
  session?.abort().catch(() => {}); // Deadline cleanup still runs in finally.
}, 120_000);
try {
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  let model = runtime.getModel("openai-codex", modelId);
  if (!model) {
    await runtime.refresh({ providers: ["openai-codex"], allowNetwork: true, signal: AbortSignal.timeout(15_000) });
    model = runtime.getModel("openai-codex", modelId);
  }
  assert.ok(model, "The requested Codex model is not in the local catalog");
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 80, reserveTokens: 4096 },
    cacheWarming: "off", transport: "sse", retry: { enabled: false, provider: { maxRetries: 0 } } });
  let providerRequests = 0;
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPromptOverride: () => "You are reviewing a synthetic software design. Do not execute tools or implement anything. Acknowledge each user message in one short sentence unless asked for a checkpoint.",
    appendSystemPromptOverride: () => [],
    extensionFactories: [(pi) => {
      pi.on("agent_start", (_event, ctx) => suspend(state, ctx));
      pi.on("context_with_system", (event, ctx) => { state.pendingRequest = observeRequest(ctx, event.messages); });
      pi.on("before_provider_request", (event, ctx) => {
        providerRequests++;
        const capture = state.pendingRequest;
        state.pendingRequest = undefined;
        if (capture) observePayload(pi, ctx, capture, event.payload);
      });
      pi.on("session_before_compact", (event, ctx) => generateCheckpoint(state, pi, ctx, event));
      pi.on("session_compact", (event, ctx) => finishAttempt(state, pi, ctx, event));
      pi.on("session_compact_failed", (event, ctx) => finishAttempt(state, pi, ctx, event));
      pi.on("session_shutdown", (_event, ctx) => dispose(state, ctx));
    }],
  });
  await loader.reload();
  const manager = SessionManager.create(cwd, agentDir);
  ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "off",
    settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: true }));
  await session.bindExtensions({});
  function requireCompletedReply(): void {
    const reply = session?.messages.findLast((message) => message.role === "assistant");
    if (!reply || reply.role !== "assistant" || reply.stopReason !== "stop") {
      throw new Error(`Live warm-up did not complete: ${reply?.role === "assistant" ? reply.errorMessage ?? reply.stopReason : "no assistant reply"}`);
    }
  }
  // Large enough to exercise prompt caching, without sending repository data.
  const reference = Array.from({ length: 90 }, (_, index) =>
    `Reference field photo_${index}: optional UTF-8 metadata; preserve the original value; missing is distinct from empty; no network lookup is permitted.`,
  ).join("\n");
  await session.prompt(`Objective: design a read-only photo indexer. Only analysis is authorized: do not write files, install dependencies, or scan photos.
Settled decisions: TypeScript, local SQLite, offline operation, originals must remain untouched.
Finding: thumbnail caching is optional, not required for the first design.
Uncertainty: EXIF timezone handling is unresolved. Ask the user for their timezone policy before proposing implementation.
Verification: design discussion only; no implementation, benchmark, or runtime check has happened.
The reference below is background data, not completed work:\n${reference}`);
  requireCompletedReply();
  await session.prompt("Keep the timezone question unresolved. No implementation is authorized. Acknowledge only.");
  requireCompletedReply();
  const assistantUsage = session.messages.filter((message) => message.role === "assistant").map((message) => message.usage);
  const result = await session.compact();
  assert.equal(state.attempt, undefined);
  assert.ok(manager.getBranch().some((entry) => entry.type === "compaction"));
  const file = session.sessionFile;
  assert.ok(file);
  assert.deepEqual(SessionManager.open(file).buildSessionProjection(), manager.buildSessionProjection());
  // Nested registry calls use their own onPayload, not the main-agent hook.
  assert.equal(providerRequests, 2, "No additional main-agent request may follow compaction");
  console.log(JSON.stringify({ provider: model.provider, model: model.id, committed: true, reopened: true,
    agentCacheRead: assistantUsage.map((usage) => usage.cacheRead), checkpointUsage: result.usage, summary: result.summary }, null, 2));
} finally {
  clearTimeout(deadline);
  session?.dispose();
  await rm(root, { recursive: true, force: true });
}
