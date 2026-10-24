// Offline host-contract probe, not the compaction implementation. Loaded by
// Vitest against node_modules and explicitly by the installed CLI's embedded SDK.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager, VERSION,
  type AgentSessionRuntime, type ExtensionAPI, type ExtensionContext, type ExtensionFactory,
  type ProviderConfig, type SessionBeforeCompactEvent, type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { compactionObservationCases } from "./compaction-observation-probe.ts";

const provider = "compaction-seam-probe";
const modelId = "offline-fixture";
const modelDefinition = {
  id: modelId, name: "Offline compaction fixture", reasoning: false, input: ["text"] as ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 4096,
};
type FixtureStream = NonNullable<ProviderConfig["streamSimple"]>;
type Reply = Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
type StreamOptions = Parameters<FixtureStream>[2];
type BeforeCompact = (event: SessionBeforeCompactEvent, ctx: ExtensionContext) =>
  SessionBeforeCompactResult | undefined | Promise<SessionBeforeCompactResult | undefined>;

function reply(text = "Offline reply"): Reply {
  return {
    role: "assistant", api: "openai-responses", provider, model: modelId,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function stream(makeReply: (options: StreamOptions) => Reply | Promise<Reply>): FixtureStream {
  return (model, context, options) => {
    const result = (async () => {
      await options?.onPayload?.({ fixture: true, messages: context.messages }, model);
      return makeReply(options);
    })();
    // Only the provider is a purpose-built fake. Pi's actual session, queue,
    // extension dispatch, compaction preparation, and persistence all execute.
    return {
      async *[Symbol.asyncIterator]() {
        const message = await result;
        yield { type: "start", partial: { ...message, content: [], stopReason: "pending" } };
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          yield { type: "error", reason: message.stopReason, error: message };
        } else yield { type: "done", reason: message.stopReason, message };
      },
      result: () => result,
    } as ReturnType<FixtureStream>;
  };
}

function latch() {
  let release: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

function checkpoint(event: SessionBeforeCompactEvent): SessionBeforeCompactResult {
  return { compaction: {
    summary: "OFFLINE_CHECKPOINT", firstKeptEntryId: event.preparation.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore, usage: reply().usage, details: { probe: true },
  } };
}

interface Trace {
  type: string;
  sessionId: string;
  idle: boolean;
  pending: boolean;
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  fromExtension?: boolean;
  errorMessage?: string;
}

async function withFixture(
  options: {
    empty?: boolean;
    before?: BeforeCompact;
    configure?: ExtensionFactory;
    makeReply?: (request: number, options: StreamOptions) => Reply | Promise<Reply>;
  },
  run: (fixture: {
    runtime: AgentSessionRuntime;
    context: () => ExtensionContext;
    trace: Trace[];
    requests: Reply[];
    hookErrors: string[];
    dispose: () => Promise<void>;
  }) => Promise<unknown>,
): Promise<unknown> {
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-seam-"));
  let runtime: AgentSessionRuntime | undefined;
  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await runtime?.dispose();
  }
  try {
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir, { mode: 0o700 });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false,
    });
    const requests: Reply[] = [];
    modelRuntime.registerProvider(provider, {
      api: "openai-responses", apiKey: "offline-dummy-key", baseUrl: "https://example.invalid",
      models: [modelDefinition], streamSimple: stream(async (streamOptions) => {
        const number = requests.length + 1;
        const response = options.makeReply ? await options.makeReply(number, streamOptions) : reply();
        requests.push(response);
        return response;
      }),
    });
    const model = modelRuntime.getModel(provider, modelId);
    assert.ok(model);
    const trace: Trace[] = [];
    const hookErrors: string[] = [];
    let context: ExtensionContext | undefined;
    function record(type: string, ctx: ExtensionContext, extra: Partial<Trace> = {}): void {
      context = ctx;
      trace.push({ type, sessionId: ctx.sessionManager.getSessionId(), idle: ctx.isIdle(), pending: ctx.hasPendingMessages(), ...extra });
    }
    const observer: ExtensionFactory = (pi) => {
      pi.on("session_start", (event, ctx) => record(event.type, ctx, { reason: event.reason }));
      pi.on("agent_start", (event, ctx) => record(event.type, ctx));
      pi.on("turn_end", (event, ctx) => { record(event.type, ctx); });
      pi.on("agent_end", (event, ctx) => record(event.type, ctx));
      pi.on("agent_before_settle", (event, ctx) => { record(event.type, ctx); });
      pi.on("agent_settled", (event, ctx) => record(event.type, ctx));
      pi.on("session_before_compact", (event, ctx) => {
        record(event.type, ctx, { reason: event.reason, willRetry: event.willRetry });
        return options.before ? options.before(event, ctx) : checkpoint(event);
      });
      pi.on("session_compact", (event, ctx) => record(event.type, ctx, {
        reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension,
      }));
      pi.on("session_compact_failed", (event, ctx) => record(event.type, ctx, {
        reason: event.reason, willRetry: event.willRetry, aborted: event.aborted,
        errorMessage: event.errorMessage, fromExtension: event.fromExtension,
      }));
      pi.on("session_tree", (event, ctx) => record(event.type, ctx));
      pi.on("session_shutdown", (event, ctx) => record(event.type, ctx, { reason: event.reason }));
    };
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 128 },
      retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off",
    });
    const manager = SessionManager.create(cwd, agentDir);
    if (!options.empty) {
      manager.appendMessage({ role: "system", content: "OFFLINE_SYSTEM", toolsAdded: [], timestamp: Date.now() });
      for (let index = 0; index < 4; index++) {
        manager.appendMessage({ role: "user", content: `USER_${index} ` + "history ".repeat(300), timestamp: Date.now() });
        manager.appendMessage(reply(`ASSISTANT_${index} ` + "evidence ".repeat(300)));
      }
    }
    runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir, modelRuntime, settingsManager,
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
          extensionFactories: options.configure ? [observer, options.configure] : [observer],
          systemPromptOverride: () => "Offline host-contract probe.", appendSystemPromptOverride: () => [],
        },
      });
      const result = await createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", tools: [],
      });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd, agentDir, sessionManager: manager });
    const bind = async () => {
      assert.ok(runtime);
      await runtime.session.bindExtensions({ onError: (error) => hookErrors.push(error.error) });
    };
    runtime.setRebindSession(bind);
    await bind();
    return await run({ runtime, context: () => { assert.ok(context); return context; }, trace, requests, hookErrors, dispose });
  } finally {
    try { await dispose(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

export const compactionSeamCases: Record<string, () => Promise<unknown>> = {
  async "manual compaction commits the hook result and rebuilds persisted context"() {
    return withFixture({}, async ({ runtime, trace, requests, hookErrors }) => {
      const session = runtime.session;
      const before = session.sessionManager.getEntries();
      const result = await session.compact("manual probe");
      assert.equal(result.summary, "OFFLINE_CHECKPOINT");
      const entries = session.sessionManager.getEntries();
      assert.deepEqual(entries.slice(0, -1), before);
      const committed = entries.at(-1);
      assert.ok(committed?.type === "compaction");
      assert.equal(committed.firstKeptEntryId, result.firstKeptEntryId);
      assert.equal(committed.fromHook, true);
      assert.deepEqual(committed.usage, reply().usage);
      const messages = session.messages;
      assert.equal(messages[0]?.role, "system");
      assert.ok(messages.some((message) => message.role === "compactionSummary" && message.summary === result.summary));
      assert.ok(messages.some((message) => message.role === "assistant"));
      assert.equal(messages.some((message) => JSON.stringify(message).includes("USER_0")), false);
      const file = session.sessionFile;
      assert.ok(file);
      assert.deepEqual(SessionManager.open(file).buildSessionContext().messages, messages);
      assert.deepEqual(trace.filter((event) => event.type.startsWith("session_" )).map((event) => event.type),
        ["session_start", "session_before_compact", "session_compact"]);
      assert.equal(trace.find((event) => event.type === "session_compact")?.idle, false,
        "Success hook runs before Pi clears its compaction busy state");
      assert.equal(session.isIdle, true);
      assert.equal(requests.length, 0, "A supplied result must bypass default generation");
      assert.deepEqual(hookErrors, []);
      return { fromHook: true, persisted: true, providerRequests: 0, idleInSuccessHook: false, idleAfterCompletion: true };
    });
  },

  async "preparation failure emits a terminal failure without entering the hook"() {
    return withFixture({ empty: true }, async ({ runtime, trace, requests }) => {
      await assert.rejects(runtime.session.compact(), /Nothing to compact/);
      assert.equal(trace.some((event) => event.type === "session_before_compact"), false);
      const failed = trace.filter((event) => event.type === "session_compact_failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].aborted, false);
      assert.equal(failed[0].reason, "manual");
      assert.match(failed[0].errorMessage ?? "", /Nothing to compact/);
      assert.equal(runtime.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
      assert.equal(requests.length, 0);
      return failed[0];
    });
  },

  async "extension-started preparation failure reaches the shared failure event"() {
    return withFixture({ empty: true }, async ({ runtime, context, trace, requests }) => {
      const ended = latch();
      const unsubscribe = runtime.session.subscribe((event) => {
        if (event.type === "compaction_end") ended.release();
      });
      try {
        context().compact();
        await ended.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        assert.equal(trace.some((event) => event.type === "session_before_compact"), false);
        const failed = trace.filter((event) => event.type === "session_compact_failed");
        assert.equal(failed.length, 1);
        assert.equal(failed[0].aborted, false);
        assert.match(failed[0].errorMessage ?? "", /Nothing to compact/);
        assert.equal(requests.length, 0);
        return { failureWithoutBeforeHook: true, callbackBookkeepingRequired: false };
      } finally { unsubscribe(); }
    });
  },

  async "default provider failure preserves context and emits one terminal failure"() {
    return withFixture({ before: () => undefined, makeReply: () => ({
      ...reply(), stopReason: "error", errorMessage: "OFFLINE_PROVIDER_FAILURE",
    }) }, async ({ runtime, trace, requests }) => {
      const session = runtime.session;
      const entries = session.sessionManager.getEntries();
      const messages = session.messages;
      await assert.rejects(session.compact(), /OFFLINE_PROVIDER_FAILURE/);
      assert.deepEqual(session.sessionManager.getEntries(), entries);
      assert.deepEqual(session.messages, messages);
      const failures = trace.filter((event) => event.type === "session_compact_failed");
      assert.equal(failures.length, 1);
      assert.equal(failures[0].aborted, false);
      assert.equal(requests.length, 1, "Retries are disabled in this probe");
      return { unchanged: true, failureEvent: true, providerRequests: requests.length };
    });
  },

  async "explicit cancellation preserves raw entries and projected context"() {
    return withFixture({ before: () => ({ cancel: true }) }, async ({ runtime, context, trace, requests }) => {
      const session = runtime.session;
      const entries = session.sessionManager.getEntries();
      const messages = session.messages;
      const terminal = latch();
      const unsubscribe = session.subscribe((event) => { if (event.type === "compaction_end") terminal.release(); });
      try {
        context().compact();
        await terminal.promise;
        await session.waitForIdle();
        // The public end event precedes the extension's failure notification.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        assert.deepEqual(session.sessionManager.getEntries(), entries);
        assert.deepEqual(session.messages, messages);
        assert.equal(trace.filter((event) => event.type === "session_compact_failed").length, 1);
        assert.equal(trace.find((event) => event.type === "session_compact_failed")?.aborted, true);
        assert.equal(requests.length, 0);
        return { extensionStarted: true, unchanged: true, failureEvent: true, providerRequests: 0 };
      } finally { unsubscribe(); }
    });
  },

  async "a throwing extraction hook falls through to Pi's default generation"() {
    return withFixture({ before: () => { throw new Error("PROBE_EXTRACTION_FAILURE"); } }, async ({ runtime, trace, requests, hookErrors }) => {
      await runtime.session.compact();
      assert.equal(requests.length, 2, "This fixture splits a turn: default history and turn-prefix generation both run");
      assert.ok(hookErrors.some((error) => error.includes("PROBE_EXTRACTION_FAILURE")));
      assert.equal(trace.find((event) => event.type === "session_compact")?.fromExtension, false);
      return { throwingIsNotCancellation: true, defaultProviderRequests: requests.length };
    });
  },

  async "abort rejects a late hook result even when extraction ignores its signal"() {
    const entered = latch();
    const release = latch();
    let signal: AbortSignal | undefined;
    return withFixture({ before: async (event) => {
      signal = event.signal;
      entered.release();
      await release.promise;
      return checkpoint(event);
    } }, async ({ runtime, trace }) => {
      const session = runtime.session;
      const entries = session.sessionManager.getEntries();
      const messages = session.messages;
      const compacting = assert.rejects(session.compact(), /cancel/i);
      try {
        await entered.promise;
        const aborting = session.abort();
        assert.equal(signal?.aborted, true);
        release.release();
        await Promise.all([compacting, aborting]);
        assert.deepEqual(session.sessionManager.getEntries(), entries);
        assert.deepEqual(session.messages, messages);
        assert.equal(trace.find((event) => event.type === "session_compact_failed")?.aborted, true);
        return { signalAborted: true, lateResultRejected: true, unchanged: true };
      } finally { release.release(); await compacting; }
    });
  },

  async "settled deferral waits for queued work and boundary continuation"() {
    const firstRequest = latch();
    const releaseFirst = latch();
    const completed = latch();
    let continued = false;
    let settledHandlerReturned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deferredChecks: { handlerReturned: boolean; idle: boolean; pending: boolean }[] = [];
    return withFixture({
      makeReply: async (request) => {
        if (request === 1) { firstRequest.release(); await releaseFirst.promise; }
        return reply(`REQUEST_${request}`);
      },
      configure: (pi) => {
        pi.on("agent_before_settle", () => {
          if (!continued) {
            continued = true;
            return {
              continue: true,
              entries: [{ type: "custom_message", customType: "probe", content: "Boundary continuation", display: false }],
            };
          }
        });
        pi.on("agent_settled", (_event, ctx) => {
          timer = setTimeout(() => {
            const observation = { handlerReturned: settledHandlerReturned, idle: ctx.isIdle(), pending: ctx.hasPendingMessages() };
            deferredChecks.push(observation);
            if (observation.idle && !observation.pending) ctx.compact();
            else completed.release(); // Fail in the awaited assertion, not an unhandled timer callback.
          }, 0);
          settledHandlerReturned = true;
        });
        pi.on("session_compact", () => completed.release());
      },
    }, async ({ runtime, trace, requests }) => {
      const session = runtime.session;
      const running = session.prompt("First prompt");
      try {
        await firstRequest.promise;
        assert.equal(session.isIdle, false);
        assert.equal(await session.followUp("Queued follow-up"), "queued");
        releaseFirst.release();
        await running;
        await completed.promise;
        await session.waitForIdle();
        assert.equal(requests.length, 3, "Initial request, queued follow-up, and boundary continuation only");
        assert.deepEqual(deferredChecks, [{ handlerReturned: true, idle: true, pending: false }]);
        assert.equal(trace.filter((event) => event.type === "agent_settled").length, 1);
        assert.ok(trace.filter((event) => event.type === "turn_end" || event.type === "agent_end").every((event) => !event.idle));
        assert.ok(trace.findIndex((event) => event.type === "session_before_compact") > trace.findIndex((event) => event.type === "agent_settled"));
        assert.equal(trace.find((event) => event.type === "session_before_compact")?.willRetry, false);
        return { requests: requests.length, settlements: 1, compactionAfterSettlement: true, compactionContinuedTask: false };
      } finally { clearTimeout(timer); releaseFirst.release(); await running; }
    });
  },

  async "deferred checks skip new busy work and wait for its next settlement"() {
    const secondRequest = latch();
    const releaseSecond = latch();
    const skipped = latch();
    const completed = latch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let skippedChecks = 0;
    return withFixture({
      makeReply: async (request) => {
        if (request === 2) { secondRequest.release(); await releaseSecond.promise; }
        return reply();
      },
      configure: (pi) => {
        pi.on("agent_settled", (_event, ctx) => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!ctx.isIdle() || ctx.hasPendingMessages()) {
              skippedChecks++;
              skipped.release();
              return; // No poll; the next settlement supplies the opportunity.
            }
            ctx.compact();
          }, 0);
        });
        pi.on("session_compact", () => completed.release());
      },
    }, async ({ runtime, trace, requests }) => {
      const session = runtime.session;
      await session.prompt("First prompt");
      const running = session.prompt("New work before the deferred check");
      try {
        await secondRequest.promise;
        await skipped.promise;
        assert.equal(trace.some((event) => event.type === "session_before_compact"), false);
        assert.equal(session.isIdle, false);
        releaseSecond.release();
        await running;
        await completed.promise;
        await session.waitForIdle();
        assert.equal(skippedChecks, 1);
        assert.equal(requests.length, 2);
        assert.equal(trace.filter((event) => event.type === "session_compact").length, 1);
        return { skippedBusyCheck: true, providerRequests: 2, compactedAtNextSettlement: true };
      } finally { clearTimeout(timer); releaseSecond.release(); await running; }
    });
  },

  async "branch navigation is rejected while a compaction hook is pending"() {
    const entered = latch();
    const release = latch();
    return withFixture({ before: async () => { entered.release(); await release.promise; return { cancel: true }; } },
      async ({ runtime }) => {
        const session = runtime.session;
        const entries = session.sessionManager.getEntries();
        const target = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
        assert.ok(target);
        const compacting = assert.rejects(session.compact(), /cancel/i);
        try {
          await entered.promise;
          await assert.rejects(session.navigateTree(target.id, { summarize: false }), /compaction.*finish/i);
          assert.deepEqual(session.sessionManager.getEntries(), entries);
          release.release();
          await compacting;
          await session.navigateTree(target.id, { summarize: false });
          assert.equal(session.sessionManager.getLeafId(), target.id);
          return { navigationBlockedWhileCompacting: true, navigationWorksAfterCancellation: true };
        } finally { release.release(); await compacting; }
      });
  },

  async "runtime disposal aborts a pending hook and rejects its late result"() {
    const entered = latch();
    const release = latch();
    let signal: AbortSignal | undefined;
    return withFixture({ before: async (event) => {
      signal = event.signal;
      entered.release();
      await release.promise;
      return checkpoint(event);
    } }, async ({ runtime, context, trace, hookErrors, dispose }) => {
      const session = runtime.session;
      const oldContext = context();
      const entries = session.sessionManager.getEntries();
      const messages = session.messages;
      const compacting = assert.rejects(session.compact(), /cancel/i);
      try {
        await entered.promise;
        await dispose();
        assert.equal(signal?.aborted, true);
        assert.throws(() => oldContext.isIdle(), /stale/i);
        assert.equal(trace.find((event) => event.type === "session_shutdown")?.reason, "quit");
        release.release();
        await compacting;
        assert.deepEqual(session.sessionManager.getEntries(), entries);
        assert.deepEqual(session.messages, messages);
        assert.ok(hookErrors.some((error) => /stale/i.test(error)),
          "A late failure notification can still reach the disposed runner with a stale ctx");
        return { signalAborted: true, lateResultRejected: true, unchanged: true, lateOutcomeContextStale: true };
      } finally { release.release(); await compacting; }
    });
  },

  async "reload requires extension-owned cancellation and invalidates old contexts"() {
    const entered = latch();
    const release = latch();
    const extraction = new AbortController();
    let signal: AbortSignal | undefined;
    return withFixture({
      before: async (event) => {
        signal = event.signal;
        entered.release();
        await release.promise;
        // This is test-local cleanup, not the checkpoint implementation. Never
        // consult a captured ctx after reload; use the owned cancellation token.
        return extraction.signal.aborted ? { cancel: true } : checkpoint(event);
      },
      configure: (pi) => { pi.on("session_shutdown", () => extraction.abort()); },
    }, async ({ runtime, context, trace }) => {
      const session = runtime.session;
      const oldContext = context();
      const entries = session.sessionManager.getEntries();
      const messages = session.messages;
      const compacting = assert.rejects(session.compact(), /cancel/i);
      try {
        await entered.promise;
        await session.reload();
        assert.equal(signal?.aborted, false, "Reload itself does not abort Pi's compaction signal");
        assert.equal(extraction.signal.aborted, true);
        assert.throws(() => oldContext.hasUI, /stale/i, "Even reporting getters reject stale contexts");
        assert.throws(() => oldContext.isIdle(), /stale/i);
        assert.equal(trace.find((event) => event.type === "session_shutdown")?.reason, "reload");
        assert.equal(trace.filter((event) => event.type === "session_start").length, 2);
        release.release();
        await compacting;
        assert.deepEqual(session.sessionManager.getEntries(), entries);
        assert.deepEqual(session.messages, messages);
        assert.equal(trace.filter((event) => event.type === "session_compact_failed").length, 1,
          "The new extension runtime can receive an outcome for the old attempt");
        return { hostSignalAborted: false, ownedCancellationRequired: true, oldContextInvalidated: true, unchanged: true };
      } finally { release.release(); await compacting; }
    });
  },

  async "source changes require final validation rather than relying on Pi's hook signal"() {
    const outcomes: unknown[] = [];
    for (const guardSource of [false, true]) {
      const entered = latch();
      const release = latch();
      let signal: AbortSignal | undefined;
      await withFixture({ before: async (event, ctx) => {
        signal = event.signal;
        const sourceLeaf = ctx.sessionManager.getLeafId();
        entered.release();
        await release.promise;
        if (guardSource && ctx.sessionManager.getLeafId() !== sourceLeaf) return { cancel: true };
        return checkpoint(event);
      } }, async ({ runtime }) => {
        const session = runtime.session;
        const compacting = session.compact();
        // Attach the rejection handler before releasing the hook.
        const completion = guardSource ? assert.rejects(compacting, /cancel/i) : compacting;
        try {
          await entered.promise;
          // Deliberately use the SDK's mutable session manager: normal tree
          // navigation is locked, but not every source writer takes that lock.
          session.sessionManager.appendMessage({ role: "user", content: "NEW_SOURCE", timestamp: Date.now() });
          const changedEntries = session.sessionManager.getEntries();
          assert.equal(signal?.aborted, false);
          release.release();
          await completion;
          if (guardSource) assert.deepEqual(session.sessionManager.getEntries(), changedEntries);
          else assert.equal(session.sessionManager.getEntries().at(-1)?.type, "compaction",
            "Pi does not reject a hook result solely because its source leaf changed");
          outcomes.push({ guardSource, committed: !guardSource, hostSignalAborted: false });
        } finally { release.release(); await completion; }
      });
    }
    return outcomes;
  },

  async "session replacement aborts extraction before shutdown and rejects its late result"() {
    const entered = latch();
    const release = latch();
    const aborted = latch();
    return withFixture({ before: async (event) => {
      event.signal.addEventListener("abort", () => aborted.release(), { once: true });
      entered.release();
      await release.promise;
      return checkpoint(event);
    } }, async ({ runtime, trace, context }) => {
      const old = runtime.session;
      const oldContext = context();
      const entries = old.sessionManager.getEntries();
      const compacting = assert.rejects(old.compact(), /cancel/i);
      try {
        await entered.promise;
        const replacing = runtime.newSession();
        await aborted.promise;
        assert.equal(trace.some((event) => event.type === "session_shutdown"), false,
          "Replacement waits for abort completion before session_shutdown");
        release.release();
        await compacting;
        await replacing;
        assert.notEqual(runtime.session, old);
        assert.deepEqual(old.sessionManager.getEntries(), entries);
        assert.equal(runtime.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
        assert.throws(() => oldContext.isIdle(), /stale/i);
        const shutdown = trace.findIndex((event) => event.type === "session_shutdown");
        const failed = trace.findIndex((event) => event.type === "session_compact_failed");
        assert.ok(failed >= 0 && shutdown > failed);
        return { abortBeforeShutdown: true, lateResultRejected: true, oldContextInvalidated: true };
      } finally { release.release(); await compacting; }
    });
  },
};

export async function runCompactionSeamProbe() {
  const checks: Record<string, unknown> = {};
  for (const [name, run] of Object.entries({ ...compactionSeamCases, ...compactionObservationCases })) checks[name] = await run();
  return {
    version: VERSION,
    runtime: { execPath: process.execPath, node: process.versions.node, bun: process.versions.bun, platform: process.platform, arch: process.arch },
    checks,
  };
}

export default function compactionSeamProbe(pi: ExtensionAPI): void {
  // Outer CLI is also offline: an accidental ordinary prompt cannot use credentials.
  pi.registerProvider(provider, {
    api: "openai-responses", apiKey: "offline-dummy-key", baseUrl: "https://example.invalid",
    models: [modelDefinition], streamSimple: stream(() => { throw new Error("Unexpected outer inference"); }),
  });
  pi.registerCommand("compaction-seam-probe", {
    description: "Verify offline compaction contracts against this runtime",
    handler: async (_args, ctx) => {
      try {
        console.log(JSON.stringify({ compactionSeamProbe: await runCompactionSeamProbe() }));
      } catch (error) {
        console.log(JSON.stringify({ compactionSeamProbeError: error instanceof Error ? error.stack : String(error) }));
      } finally { ctx.shutdown(); }
    },
  });
}
