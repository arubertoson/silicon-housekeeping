// Actual Codex serialization and HTTP/SSE, with a loopback server and synthetic
// credentials. No provider inference, account credentials, or external network.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compactionAttemptType, fingerprint, observePayload, observeRequest, readObservation, reconstructRequest, requestObservationType,
  type RequestCapture, type RequestObservation } from "../support/compaction-observation.ts";
import { dispose, type CompactionState } from "../support/compaction-state.ts";
import { requestCheckpoint } from "../support/compaction-request.ts";
import { finishAttempt, generateCheckpoint } from "../support/compaction-draft.ts";

const modelId = "gpt-5.4";
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } })).toString("base64")}.fixture`;

const fixtureCheckpoint = `## Intent
Preserve the fixture task.
## Constraints and Authority
No tool execution or task continuation is authorized.
## Progress and Findings
The fixture includes structured tool arguments and a tool result.
## Uncertainty and Verification
Only offline serialization has been checked; no live cache hit is claimed.
## Current State
The current user message and reply remain in the retained tail.
## Next Action
Wait for the user's next instruction.`;

function installManualCheckpoint(pi: ExtensionAPI, state: CompactionState): void {
  pi.on("session_before_compact", (event, ctx) => generateCheckpoint(state, pi, ctx, event));
  pi.on("session_compact", (event, ctx) => finishAttempt(state, pi, ctx, event));
  pi.on("session_compact_failed", (event, ctx) => finishAttempt(state, pi, ctx, event));
}

async function withCodex(
  options: {
    beforeObserver?: ExtensionFactory;
    afterObserver?: ExtensionFactory;
    transport?: "sse" | "auto";
    summaryText?: string;
    beforeCheckpointReply?: () => void | Promise<void>;
  },
  run: (fixture: { session: AgentSession; ctx: () => ExtensionContext; pi: () => ExtensionAPI;
    observations: RequestObservation[]; bodies: unknown[]; trace: string[]; state: CompactionState; errors: string[] }) => Promise<unknown>,
): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-observe-"));
  // These cases run sequentially, also inside the isolated CLI. Ensure ambient
  // proxy settings cannot send the loopback fixture to an external proxy.
  const previousNoProxy = process.env.no_proxy;
  process.env.no_proxy = "*";
  let session: AgentSession | undefined;
  const bodies: unknown[] = [];
  const trace: string[] = [];
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const decoded = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes;
      const body: unknown = JSON.parse(decoded.toString("utf8"));
      bodies.push(body);
      trace.push("wire");
      assert.equal(request.url, "/codex/responses");
      if (bodies.length > 1) await options.beforeCheckpointReply?.();
      const text = bodies.length > 1 ? options.summaryText ?? "OFFLINE_RESPONSE" : "OFFLINE_RESPONSE";
      const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }] };
      const events = [
        { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
          usage: { input_tokens: 120, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } } } },
      ];
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      errors.push(String(error));
      response.writeHead(500);
      response.end("Offline fixture failure");
    }
  });
  // Auto transport must fall back locally, never wait on an external endpoint.
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"));
  const state: CompactionState = { generation: 0 };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir, { mode: 0o700 });
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider("openai-codex", {
      api: "openai-codex-responses", apiKey: token, baseUrl: `http://127.0.0.1:${address.port}`,
      models: [{ id: modelId, name: "Offline Codex serializer", reasoning: true, input: ["text", "image"],
        contextWindow: 32_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const model = runtime.getModel("openai-codex", modelId);
    assert.ok(model);
    const observations: RequestObservation[] = [];
    let context: ExtensionContext | undefined;
    let api: ExtensionAPI | undefined;
    const observer: ExtensionFactory = (pi) => {
      api = pi;
      pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "TOOL_DESCRIPTION_MARKER",
        parameters: Type.Object({ input: Type.String() }),
        execute: async () => { throw new Error("No tool execution is authorized by this fixture"); } });
      pi.on("session_start", (_event, ctx) => { context = ctx; });
      pi.on("context_with_system", (event, ctx) => {
        trace.push("context");
        state.pendingRequest = observeRequest(ctx, event.messages);
      });
      pi.on("before_provider_request", (event, ctx) => {
        trace.push("payload");
        const capture = state.pendingRequest;
        state.pendingRequest = undefined;
        if (capture) {
          const record = observePayload(pi, ctx, capture, event.payload);
          if (record) observations.push(record);
        }
      });
      pi.on("before_provider_headers", () => { trace.push("headers"); });
      pi.on("after_provider_response", () => { trace.push("response"); });
    };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 20, reserveTokens: 4096 }, cacheWarming: "off", transport: options.transport ?? "sse",
      retry: { enabled: false, provider: { maxRetries: 0 } } });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [...(options.beforeObserver ? [options.beforeObserver] : []), observer, ...(options.afterObserver ? [options.afterObserver] : [])],
      systemPromptOverride: () => "SYSTEM_INSTRUCTION_MARKER", appendSystemPromptOverride: () => [] });
    await loader.reload();
    const manager = SessionManager.create(cwd, agentDir);
    manager.appendMessage({ role: "user", content: [
      { type: "text", text: "PRIOR_USER_MARKER" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V8AAAAASUVORK5CYII=" },
    ], timestamp: 100 });
    manager.appendMessage({ role: "assistant", provider: "openai-codex", api: "openai-codex-responses", model: modelId,
      content: [
        { type: "thinking", thinking: "Fixture reasoning", thinkingSignature: JSON.stringify({
          type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "OPAQUE_ENCRYPTED_MARKER",
        }) },
        { type: "toolCall", id: "call_fixture|fc_fixture", name: "fixture_tool", arguments: { input: "STRUCTURED_ARGUMENT_MARKER" } },
      ],
      stopReason: "toolUse", timestamp: 101,
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    manager.appendMessage({ role: "toolResult", toolCallId: "call_fixture|fc_fixture", toolName: "fixture_tool",
      content: [{ type: "text", text: "TOOL_RESULT_MARKER" }], isError: false, timestamp: 102 });
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "high", settingsManager: settings,
      sessionManager: manager, resourceLoader: loader, tools: ["fixture_tool"] }));
    await session.bindExtensions({ onError: (error) => errors.push(error.error) });
    return await run({ session, ctx: () => { assert.ok(context); return context; }, pi: () => { assert.ok(api); return api; }, observations, bodies, trace, state, errors });
  } finally {
    try {
      // Cleanup deliberately tolerates invalid extension contexts.
      dispose(state, {} as ExtensionContext);
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    } finally {
      if (previousNoProxy === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = previousNoProxy;
    }
  }
}

export const compactionObservationCases: Record<string, () => Promise<unknown>> = {
  async "loopback proxy override is restored when a probe fails"() {
    const previousNoProxy = process.env.no_proxy;
    const failure = new Error("fixture cleanup probe");
    await assert.rejects(withCodex({}, async () => {
      assert.equal(process.env.no_proxy, "*");
      throw failure;
    }), (error) => error === failure);
    assert.equal(process.env.no_proxy, previousNoProxy);
    return { proxyOverrideRestored: true };
  },

  async "Codex capture reconstructs the branch and matches native SSE serialization"() {
    return withCodex({}, async ({ session, ctx, observations, bodies, trace, errors }) => {
      await session.prompt("CURRENT_USER_MARKER");
      assert.deepEqual(errors, []);
      assert.equal(bodies.length, 1);
      assert.deepEqual(trace, ["context", "headers", "payload", "wire", "response"]);
      assert.equal(observations.length, 1);
      const record = observations[0];
      assert.equal(record.unavailableReason, undefined);
      assert.equal(record.payloadFingerprint, fingerprint(bodies[0]));
      assert.deepEqual(record.parameters, { verbosity: "low", toolChoice: "auto", reasoning: { effort: "high", summary: "auto" } });
      const candidate = reconstructRequest(ctx(), record);
      assert.equal(candidate.kind, "candidate");
      if (candidate.kind !== "candidate") throw new Error(candidate.reason);
      assert.equal(fingerprint(candidate.messages), record.transcriptFingerprint);
      const serialized = JSON.stringify(bodies[0]);
      for (const marker of ["SYSTEM_INSTRUCTION_MARKER", "TOOL_DESCRIPTION_MARKER", "CURRENT_USER_MARKER", "STRUCTURED_ARGUMENT_MARKER", "TOOL_RESULT_MARKER", "OPAQUE_ENCRYPTED_MARKER", "data:image/png;base64,iVBOR"]) {
        assert.ok(serialized.includes(marker), `Wire request lost ${marker}`);
        assert.equal(JSON.stringify(record).includes(marker), false, `Metadata duplicated ${marker}`);
      }
      assert.equal(JSON.stringify(record).includes(token), false);
      const observation = readObservation(ctx());
      assert.equal(observation.response?.cacheRead, 80);
      assert.equal(observation.response?.cacheWrite, 0);
      assert.equal(observation.cache, undefined, "No TTL is inferred from usage or a cache key");
      assert.deepEqual(observation.eligibility, { kind: "candidate", reason: "on-payload-verification-required" });
      const before = session.sessionManager.getEntries();
      const model = ctx().model;
      assert.ok(model);
      const replay = ctx().modelRegistry.streamSimple(model, { messages: candidate.messages }, {
        sessionId: record.sessionId, transport: "sse", reasoning: "high", maxRetries: 0,
        onPayload(payload) {
          assert.equal(fingerprint(payload), record.payloadFingerprint, "Native replay must serialize identically");
          throw new Error("OFFLINE_STOP_BEFORE_SEND");
        },
      });
      for await (const _event of replay) { /* No network or tool loop for replay. */ }
      assert.match((await replay.result()).errorMessage ?? "", /OFFLINE_STOP_BEFORE_SEND/);
      assert.equal(bodies.length, 1);
      assert.deepEqual(session.sessionManager.getEntries(), before);
      const file = session.sessionFile;
      assert.ok(file);
      const reopened = SessionManager.open(file);
      const reopenedContext = new Proxy(ctx(), { get: (target, key) => key === "sessionManager" ? reopened : Reflect.get(target, key) });
      assert.deepEqual(readObservation(reopenedContext), observation);
      return { realCodexSse: true, serializationIdentical: true, persistedBranchReplay: true, cacheReadFixture: 80,
        cacheLifetime: "unknown", captureProvenance: "before_provider_request" };
    });
  },

  async "checkpoint request extends the native Codex prefix without replacing context"() {
    return withCodex({ beforeObserver: (pi) => {
      pi.on("before_provider_request", (event) => {
        assert.ok(event.payload && typeof event.payload === "object");
        return { ...event.payload, text: { verbosity: "high" }, temperature: 0.3, service_tier: "priority",
          reasoning: { effort: "high", summary: "detailed" } };
      });
    } }, async ({ session, pi, bodies, observations, errors }) => {
      await session.prompt("Checkpoint source");
      const before = session.sessionManager.getEntries();
      let response: Awaited<ReturnType<typeof requestCheckpoint>> | undefined;
      let requestError: unknown;
      pi().on("session_before_compact", async (event, ctx) => {
        try {
          response = await requestCheckpoint(ctx, event, new AbortController().signal);
        } catch (error) {
          requestError = error;
        }
        // This slice deliberately stops before checkpoint acceptance/commit.
        return { cancel: true };
      });
      await assert.rejects(session.compact("SUMMARY_FOCUS_MARKER"), /Compaction cancelled/);
      assert.equal(requestError, undefined);
      assert.equal(response?.stopReason, "stop");
      assert.equal(response.usage.cacheRead, 80, "Synthetic fixture usage, not a live cache measurement");
      assert.equal(bodies.length, 2, "One agent request and one checkpoint request, with no continuation");
      const [original, summary] = bodies;
      assert.ok(original && typeof original === "object" && "input" in original && Array.isArray(original.input));
      assert.ok(summary && typeof summary === "object" && "input" in summary && Array.isArray(summary.input));
      assert.deepEqual(summary.input.slice(0, original.input.length), original.input);
      assert.deepEqual({ ...summary, input: original.input }, original, "Instructions, tools, settings and session key stay unchanged");
      assert.match(JSON.stringify(summary.input.at(-1)), /SUMMARY_FOCUS_MARKER/);
      assert.match(JSON.stringify(summary.input.at(-1)), /Constraints and Authority/);
      assert.equal(observations.length, 1, "The nested checkpoint must not become a main-agent capture");
      assert.deepEqual(session.sessionManager.getEntries(), before);
      assert.deepEqual(errors, []);
      return { checkpointRequestSent: true, prefixPreserved: true, contextUnchanged: true, liveCacheMeasured: false };
    });
  },

  async "checkpoint request rejects a captured-prefix mismatch before sending"() {
    return withCodex({ beforeObserver: (pi) => {
      pi.on("before_provider_request", (event) => {
        assert.ok(event.payload && typeof event.payload === "object");
        return { ...event.payload, instructions: "REQUEST_ONLY_INSTRUCTIONS" };
      });
    } }, async ({ session, pi, bodies, errors }) => {
      await session.prompt("Checkpoint mismatch source");
      const before = session.sessionManager.getEntries();
      let requestError: unknown;
      pi().on("session_before_compact", async (event, ctx) => {
        try {
          await requestCheckpoint(ctx, event, new AbortController().signal);
        } catch (error) {
          requestError = error;
        }
        return { cancel: true };
      });
      await assert.rejects(session.compact(), /Compaction cancelled/);
      assert.match(String(requestError), /differs from the captured provider prefix/);
      assert.equal(bodies.length, 1, "Neither a mismatched replay nor a default summarization is sent");
      assert.deepEqual(session.sessionManager.getEntries(), before);
      assert.deepEqual(errors, []);
      return { prefixMismatchRejected: true, noSummarySent: true, contextUnchanged: true };
    });
  },

  async "manual checkpoint is committed and rebuilt by Pi without continuation"() {
    return withCodex({ summaryText: fixtureCheckpoint }, async ({ session, pi, ctx, state, bodies, errors }) => {
      await session.prompt("Checkpoint commit source");
      installManualCheckpoint(pi(), state);
      let preparedBoundary: string | undefined;
      pi().on("session_before_compact", (event) => { preparedBoundary = event.preparation.firstKeptEntryId; });
      const result = await session.compact();
      assert.equal(result.firstKeptEntryId, preparedBoundary);
      assert.equal(result.summary, fixtureCheckpoint);
      assert.equal(result.usage?.cacheRead, 80, "Synthetic usage only");
      const checkpoint = session.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
      assert.ok(checkpoint && checkpoint.type === "compaction" && checkpoint.fromHook);
      assert.equal(checkpoint.summary, fixtureCheckpoint);
      assert.deepEqual(session.agent.state.messages, session.sessionManager.buildSessionProjection().messages);
      const file = session.sessionFile;
      assert.ok(file);
      assert.deepEqual(SessionManager.open(file).buildSessionProjection(), session.sessionManager.buildSessionProjection());
      assert.equal(readObservation(ctx()).lastAttempt?.outcome, "committed");
      assert.equal(state.attempt, undefined);
      assert.equal(bodies.length, 2, "One checkpoint request and no task continuation");
      assert.deepEqual(errors, []);
      return { committedByPi: true, rebuiltByPi: true, reopened: true, continuationRequests: 0 };
    });
  },

  async "manual checkpoint rejects invalid output without default fallback"() {
    return withCodex({ summaryText: "" }, async ({ session, pi, ctx, state, bodies, errors }) => {
      await session.prompt("Checkpoint rejection source");
      const before = session.sessionManager.buildSessionProjection().messages;
      installManualCheckpoint(pi(), state);
      await assert.rejects(session.compact(), /Compaction cancelled/);
      assert.deepEqual(session.sessionManager.buildSessionProjection().messages, before);
      assert.equal(session.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
      assert.equal(readObservation(ctx()).lastAttempt?.outcome, "failed");
      assert.equal(state.attempt, undefined);
      assert.equal(bodies.length, 2, "No default summarizer or task continuation");
      assert.deepEqual(errors, []);
      return { invalidOutputRejected: true, contextPreserved: true, fallbackRequests: 0 };
    });
  },

  async "manual checkpoint honors extension-owned cancellation"() {
    let cancel = () => {};
    return withCodex({ summaryText: fixtureCheckpoint, beforeCheckpointReply: () => cancel() }, async ({ session, pi, ctx, state, bodies, errors }) => {
      await session.prompt("Checkpoint cancellation source");
      const before = session.sessionManager.buildSessionProjection().messages;
      installManualCheckpoint(pi(), state);
      cancel = () => state.attempt?.controller.abort();
      await assert.rejects(session.compact(), /Compaction cancelled/);
      assert.deepEqual(session.sessionManager.buildSessionProjection().messages, before);
      assert.equal(readObservation(ctx()).lastAttempt?.outcome, "cancelled");
      assert.equal(state.attempt, undefined);
      assert.equal(bodies.length, 2);
      assert.deepEqual(errors, []);
      return { ownedCancellation: true, contextPreserved: true };
    });
  },

  async "manual checkpoint rejects a source changed during generation"() {
    let changeSource = () => {};
    return withCodex({ summaryText: fixtureCheckpoint, beforeCheckpointReply: () => changeSource() }, async ({ session, pi, state, bodies, errors }) => {
      await session.prompt("Checkpoint stale source");
      const before = session.sessionManager.buildSessionProjection().messages;
      installManualCheckpoint(pi(), state);
      changeSource = () => { session.sessionManager.appendCustomEntry("late.source.change", {}); };
      await assert.rejects(session.compact(), /Compaction cancelled/);
      assert.deepEqual(session.sessionManager.buildSessionProjection().messages, before);
      assert.equal(session.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
      const attempts = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === compactionAttemptType);
      assert.equal(attempts.length, 2, "Started and failed outcomes share one attempt lifecycle");
      assert.equal(state.attempt, undefined);
      assert.equal(bodies.length, 2);
      assert.deepEqual(errors, []);
      return { staleOutputRejected: true, contextPreserved: true };
    });
  },

  async "request captures are consumed once and reject stale or unrelated payloads"() {
    return withCodex({}, async ({ session, ctx, pi, observations, bodies, state }) => {
      await session.prompt("Capture fixture");
      const payload = bodies[0];
      assert.ok(payload && typeof payload === "object");
      function capture(): RequestCapture {
        const value = observeRequest(ctx(), ctx().sessionManager.buildSessionProjection().messages);
        assert.ok(value);
        return value;
      }
      const before = session.sessionManager.getEntries().length;
      const unrelated = capture();
      assert.equal(observePayload(pi(), ctx(), unrelated, { ...payload, prompt_cache_key: "another-session" }), undefined);
      assert.equal(unrelated.status, "consumed");
      assert.equal(observePayload(pi(), ctx(), unrelated, payload), undefined);
      const stale = capture();
      state.pendingRequest = stale;
      dispose(state, ctx());
      assert.equal(stale.status, "invalidated");
      assert.equal(observePayload(pi(), ctx(), stale, payload), undefined);
      const wrongSource = capture();
      session.sessionManager.appendCustomEntry("unrelated.source.change", {});
      assert.equal(observePayload(pi(), ctx(), wrongSource, payload), undefined);
      const valid = capture();
      assert.ok(observePayload(pi(), ctx(), valid, payload));
      assert.equal(observePayload(pi(), ctx(), valid, payload), undefined);
      assert.equal(session.sessionManager.getEntries().length, before + 2, "Only source metadata and the single accepted observation append");
      assert.equal(observations.length, 1, "Direct fixture observations do not use the main-agent hook");
      return { consumedOnce: true, invalidatedCaptureRejected: true, wrongSourceRejected: true, unrelatedPayloadRejected: true };
    });
  },

  async "unsupported payload settings are rejected without persisting arbitrary fields or secrets"() {
    return withCodex({}, async ({ session, ctx, pi, bodies }) => {
      await session.prompt("Safe metadata fixture");
      const payload = bodies[0];
      assert.ok(payload && typeof payload === "object");
      const capture = observeRequest(ctx(), ctx().sessionManager.buildSessionProjection().messages);
      assert.ok(capture);
      const rejected = observePayload(pi(), ctx(), capture, { ...payload,
        service_tier: "UNSAFE_SETTING_SECRET", authorization: "UNSAFE_HEADER_SECRET" });
      assert.ok(rejected);
      assert.equal(rejected.unavailableReason, "unsupported-payload-settings");
      assert.equal(rejected.parameters, undefined);
      assert.equal(JSON.stringify(rejected).includes("UNSAFE_"), false);
      assert.equal(readObservation(ctx()).eligibility.reason, "unsupported-payload-settings");
      const withHeaders = new Proxy(ctx(), { get: (target, key) => key === "model" ? {
        ...target.model, headers: { Authorization: "UNSAFE_HEADER_SECRET" },
      } : Reflect.get(target, key) });
      const headerCapture = observeRequest(withHeaders, ctx().sessionManager.buildSessionProjection().messages);
      assert.ok(headerCapture);
      const headerRecord = observePayload(pi(), withHeaders, headerCapture, payload);
      assert.ok(headerRecord);
      assert.equal(headerRecord.unavailableReason, "custom-model-headers");
      assert.equal(JSON.stringify(headerRecord).includes("UNSAFE_"), false);
      return { unknownSettingsRejected: true, customHeadersRejected: true, noSecretMetadata: true };
    });
  },

  async "nested registry calls do not consume the main-agent capture"() {
    return withCodex({ afterObserver: (pi) => {
      pi.on("context_with_system", async (_event, ctx) => {
        assert.ok(ctx.model);
        const nested = ctx.modelRegistry.streamSimple(ctx.model, { messages: [
          { role: "user", content: "UNRELATED_NESTED_REQUEST", timestamp: 0 },
        ] }, { sessionId: ctx.sessionManager.getSessionId(), transport: "sse", maxRetries: 0 });
        for await (const _event of nested) { /* Registry calls do not inherit the main agent's hooks. */ }
        assert.equal((await nested.result()).stopReason, "stop");
      });
    } }, async ({ session, observations, bodies, trace, errors }) => {
      await session.prompt("Main agent request");
      assert.deepEqual(errors, []);
      assert.equal(bodies.length, 2);
      assert.equal(observations.length, 1);
      assert.equal(trace.filter((event) => event === "payload").length, 1);
      assert.equal(observations[0].payloadFingerprint, fingerprint(bodies[1]));
      return { nestedRequestExcluded: true, mainAgentCapturePreserved: true };
    });
  },

  async "unsupported models and changed model, session, thinking, or serializer identity are rejected"() {
    return withCodex({}, async ({ session, ctx, pi, observations, bodies }) => {
      await session.prompt("Identity fixture");
      const context = ctx();
      const record = observations[0];
      assert.ok(context.model);
      const differentModel = new Proxy(context, { get: (target, key) => key === "model" ? { ...context.model, id: "another-model" } : Reflect.get(target, key) });
      assert.deepEqual(reconstructRequest(differentModel, record), { kind: "unavailable", reason: "different-model-configuration" });
      const unsupported = new Proxy(context, { get: (target, key) => key === "model" ? { ...context.model, provider: "not-codex" } : Reflect.get(target, key) });
      assert.equal(observeRequest(unsupported, context.sessionManager.buildSessionProjection().messages), undefined);
      assert.equal(readObservation(unsupported).eligibility.reason, "unsupported-provider-api");
      const foreign = SessionManager.inMemory();
      const otherSession = new Proxy(context, { get: (target, key) => key === "sessionManager" ? foreign : Reflect.get(target, key) });
      const capture = observeRequest(context, context.sessionManager.buildSessionProjection().messages);
      assert.ok(capture);
      assert.equal(observePayload(pi(), otherSession, capture, bodies[0]), undefined);
      assert.deepEqual(reconstructRequest(otherSession, record), { kind: "unavailable", reason: "different-session" });
      assert.deepEqual(reconstructRequest(context, { ...record, sdkVersion: "different-version" }), { kind: "unavailable", reason: "different-serializer-version" });
      session.setThinkingLevel("low");
      assert.deepEqual(reconstructRequest(context, record), { kind: "unavailable", reason: "different-thinking-level" });
      return { unsupportedProviderRejected: true, modelSessionThinkingAndVersionChecked: true };
    });
  },

  async "active-branch reads reject corrupted, edited, or abandoned request sources"() {
    return withCodex({}, async ({ session, ctx, observations }) => {
      await session.prompt("Active branch");
      const record = observations[0];
      const firstLeaf = session.sessionManager.getLeafId();
      assert.ok(firstLeaf);
      const source = session.sessionManager.getEntry(record.sourceEntryId);
      assert.ok(source);
      for (const parameters of [undefined, { verbosity: "injected-secret" }]) {
        session.sessionManager.appendCustomEntry(requestObservationType, { ...record, parameters });
        assert.equal(readObservation(ctx()).eligibility.reason, "invalid-request-metadata");
        session.sessionManager.branch(firstLeaf);
        assert.equal(readObservation(ctx()).requestId, record.id, "Abandoned corrupt metadata must not shadow the active branch");
      }
      assert.deepEqual(reconstructRequest(ctx(), { ...record, parameters: undefined }), {
        kind: "unavailable", reason: "unsupported-payload-settings",
      });
      assert.ok(source.parentId);
      session.sessionManager.branch(source.parentId);
      assert.equal(readObservation(ctx()).eligibility.reason, "no-request-observation");
      assert.deepEqual(reconstructRequest(ctx(), record), { kind: "unavailable", reason: "source-not-on-active-branch" });
      session.sessionManager.branch(firstLeaf);
      session.sessionManager.appendContextEdit(record.sourceEntryId, { role: "user", content: "EDITED_SOURCE_MARKER" });
      assert.equal(reconstructRequest(ctx(), record).kind, "unavailable");
      assert.equal(readObservation(ctx()).eligibility.reason, "context-no-longer-extends-request");
      return { activeBranchOnly: true, corruptedMetadataRejected: true, sourceEditRejected: true };
    });
  },

  async "request-local context transformations are explicitly ineligible"() {
    return withCodex({ beforeObserver: (pi) => {
      pi.on("context", (event) => ({ messages: event.messages.map((message) => message.role === "user" ? { ...message, content: "REQUEST_LOCAL_TRANSFORM" } : message) }));
    } }, async ({ session, ctx, observations }) => {
      await session.prompt("Persisted source");
      assert.equal(observations[0].unavailableReason, "request-local-context");
      assert.equal(readObservation(ctx()).eligibility.reason, "request-local-context");
      return { requestLocalTransformationRejected: true };
    });
  },

  async "Codex auto transport is explicitly unsupported even when it falls back to SSE"() {
    return withCodex({ transport: "auto" }, async ({ session, ctx, observations, bodies }) => {
      await session.prompt("Auto transport");
      assert.equal(bodies.length, 1);
      assert.equal(observations[0].unavailableReason, "unsupported-transport");
      assert.equal(readObservation(ctx()).eligibility.reason, "unsupported-transport");
      return { autoRejected: true, noAssumedWebsocketPrefix: true };
    });
  },

  async "later payload handlers remain outside the captured-prefix evidence"() {
    return withCodex({ afterObserver: (pi) => {
      pi.on("before_provider_request", (event) => {
        assert.ok(event.payload && typeof event.payload === "object");
        return { ...event.payload, instructions: "LATER_HANDLER_REPLACEMENT" };
      });
    } }, async ({ session, ctx, observations, bodies }) => {
      await session.prompt("Hook ordering");
      assert.notEqual(observations[0].payloadFingerprint, fingerprint(bodies[0]));
      assert.equal(readObservation(ctx()).eligibility.kind, "candidate");
      return { laterReplacementInvisibleToObserver: true, captureIsNotWireEvidence: true };
    });
  },
};
