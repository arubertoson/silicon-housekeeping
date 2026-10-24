import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as compaction from "../support/compaction.ts";

export default function compactionExtension(pi: ExtensionAPI): void {
  // Only transient coordination lives here. Decision inputs live in the session.
  const state: compaction.CompactionState = { generation: 0 };

  function requestCheck(ctx: ExtensionContext, checkAt = Date.now()): void {
    // One timer, no policy: its callback only says "time to check". Even an
    // immediate check is deferred until after the current Pi handler returns.
    compaction.scheduleCheck(state, checkAt, () => check(ctx));
  }

  function check(ctx: ExtensionContext): void {
    // Re-read current conditions, regardless of what originally armed the timer.
    // ctx.compact() aborts first: never interrupt a run or queued work.
    if (!ctx.isIdle() || ctx.hasPendingMessages() || state.attempt) return;
    const configuration = compaction.resolveCompactionConfig(pi.getSettings(), ctx.model);
    if (configuration.kind === "invalid") {
      console.error("Automatic compaction disabled:", configuration.reason);
      return;
    }
    if (!configuration.config.enabled) return;
    const decision = compaction.decideCompaction({
      observation: compaction.readObservation(ctx, configuration.config),
      contextUsage: ctx.getContextUsage(),
      configuration: configuration.config,
      now: Date.now(),
    });
    if (decision.kind === "wait") {
      requestCheck(ctx, decision.checkAt);
    } else if (decision.kind === "compact") {
      // Begin only after accepting the decision. Pi prepares the retained tail
      // and commits the replacement; success/failure events handle the outcome.
      compaction.beginAttempt(state, pi, ctx, decision.trigger);
      ctx.compact();
    }
    // Otherwise do nothing. No polling, continuation, or forced overflow recovery.
  }

  // Identify the structured main-agent request, including system instructions
  // and tools. Keep fingerprints/references, not a second conversation store.
  pi.on("context_with_system", (event, ctx) => {
    if (state.pendingRequest) state.pendingRequest.status = "invalidated";
    state.pendingRequest = undefined;
    state.pendingRequest = compaction.observeRequest(ctx, event.messages);
  });

  // Consume that capture to correlate provider serialization. Observe only;
  // neither change the agent's payload/cache policy nor capture unrelated calls.
  pi.on("before_provider_request", (event, ctx) => {
    const request = state.pendingRequest;
    state.pendingRequest = undefined;
    if (request) compaction.observePayload(pi, ctx, request, event.payload);
  });

  // A resumed session may already have a known warm cache. The check reads the
  // active branch's metadata; there is no separate restoration step.
  pi.on("session_start", (_event, ctx) => requestCheck(ctx));

  // New agent work takes priority over idle timers and checkpoint extraction.
  pi.on("agent_start", (_event, ctx) => compaction.suspend(state, ctx));

  // Settlement is after automatic retries and queued continuation. It and timer
  // expiry feed the same check; neither is itself a decision to compact.
  pi.on("agent_settled", (_event, ctx) => {
    if (state.pendingRequest) state.pendingRequest.status = "invalidated";
    state.pendingRequest = undefined;
    requestCheck(ctx);
  });

  // Both our triggers and explicit /compact use one extractor and format.
  // Validate prefix/output/source identity, then return Pi's retained-tail
  // boundary with the checkpoint. Pi's built-in automatic compaction stays disabled.
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      return await compaction.generateCheckpoint(state, pi, ctx, event);
    } catch (error) {
      // Reload can invalidate ctx while extraction awaits. Even ctx.hasUI then
      // throws; reporting must not turn explicit cancellation into fallback.
      console.error("Checkpoint extraction failed:", error);
      // Throwing or returning undefined could invoke Pi's default summarizer.
      return { cancel: true };
    }
  });

  // One outcome path, including manual /compact. Generation alone is not a
  // committed replacement. These handlers record the outcome and release work.
  pi.on("session_compact", (event, ctx) => compaction.finishAttempt(state, pi, ctx, event));
  pi.on("session_compact_failed", (event, ctx) => compaction.finishAttempt(state, pi, ctx, event));

  // Eager cleanup after branch/model changes, followed by a normal check. Final
  // source validation remains necessary even with these cancellation hooks.
  function reconsider(ctx: ExtensionContext): void {
    compaction.invalidate(state, ctx);
    requestCheck(ctx);
  }
  pi.on("session_tree", (_event, ctx) => reconsider(ctx));
  pi.on("model_select", (_event, ctx) => reconsider(ctx));
  pi.on("thinking_level_select", (_event, ctx) => reconsider(ctx));

  // Reload, exit, and session replacement must leave no timers or extraction
  // running; late callbacks must not affect a new session/runtime.
  pi.on("session_shutdown", (_event, ctx) => compaction.dispose(state, ctx));
}
