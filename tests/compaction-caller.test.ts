import type {
  ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

vi.mock("../support/compaction.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../support/compaction.ts")>(),
  generateCheckpoint: vi.fn(async () => { throw new Error("Extraction rejected after reload"); }),
}));
import compactionExtension from "../extensions/compaction.ts";
import * as compaction from "../support/compaction.ts";

type BeforeCompact = (event: SessionBeforeCompactEvent, ctx: ExtensionContext) =>
  Promise<SessionBeforeCompactResult | undefined>;

it("cancels extraction failure without touching a context invalidated by reload", async () => {
  let beforeCompact: BeforeCompact | undefined;
  // Only registration and the failure handler are under test. The separate host
  // probe establishes that reload really invalidates hasUI as well as methods.
  const registration = {
    on(event: string, handler: BeforeCompact) {
      if (event === "session_before_compact") beforeCompact = handler;
    },
  };
  compactionExtension(registration as unknown as ExtensionAPI);
  expect(beforeCompact).toBeDefined();
  if (!beforeCompact) throw new Error("Compaction hook was not registered");
  const staleContext = {
    get hasUI(): boolean { throw new Error("stale context"); },
  };
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // The rejecting supporting operation consumes neither argument. These
    // partial fixtures ensure the caller itself needs no context after failure.
    expect(await beforeCompact({} as SessionBeforeCompactEvent, staleContext as ExtensionContext)).toEqual({ cancel: true });
    expect(logging).toHaveBeenCalledOnce();
  } finally { logging.mockRestore(); }
});

it("defers fresh checks, yields to busy or queued work, and does not poll or duplicate active attempts", async () => {
  vi.useFakeTimers();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let enabled = false;
  const registration = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
    getSettings: () => ({ cacheAwareCompaction: { enabled } }),
  };
  let idle = false;
  let queued = false;
  let tokens = compaction.sizeTargetTokens - 1;
  let ownedState: compaction.CompactionState | undefined;
  const compact = vi.fn(() => expect(ownedState?.attempt?.phase).toBe("requested"));
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => queued,
    getContextUsage: () => ({ tokens, contextWindow: 272_000, percent: null }),
    compact,
  } as unknown as ExtensionContext;
  const observe = vi.spyOn(compaction, "readObservation").mockReturnValue({
    requestId: "request", evidenceFingerprint: "a".repeat(64),
    eligibility: { kind: "candidate", reason: "on-payload-verification-required" },
  });
  const begin = vi.spyOn(compaction, "beginAttempt").mockImplementation((state, _pi, _ctx, trigger) => {
    ownedState = state;
    state.attempt = { id: "attempt", sessionId: "session", generation: state.generation, trigger,
      controller: new AbortController(), phase: "requested" };
  });
  function emit(event: string): void {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`Missing handler: ${event}`);
    handler({}, ctx);
  }
  try {
    compactionExtension(registration as unknown as ExtensionAPI);
    expect(vi.getTimerCount()).toBe(0);
    emit("session_start");
    expect(observe).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(observe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    idle = true;
    queued = true;
    emit("agent_settled");
    await vi.runOnlyPendingTimersAsync();
    expect(observe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    queued = false;
    emit("agent_settled");
    await vi.runOnlyPendingTimersAsync();
    expect(observe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    enabled = true;
    emit("agent_settled");
    emit("agent_start");
    await vi.runOnlyPendingTimersAsync();
    expect(observe).not.toHaveBeenCalled();

    emit("agent_settled");
    await vi.runOnlyPendingTimersAsync();
    expect(compact).not.toHaveBeenCalled();
    tokens = compaction.sizeTargetTokens;
    emit("agent_settled");
    await vi.runOnlyPendingTimersAsync();
    expect(begin).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledExactlyOnceWith();

    emit("agent_settled");
    await vi.runOnlyPendingTimersAsync();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(compact).toHaveBeenCalledOnce();
    const controller = ownedState?.attempt?.controller;
    emit("agent_start");
    expect(controller?.signal.aborted).toBe(true);
    emit("session_shutdown");
    expect(ownedState?.attempt).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    observe.mockRestore();
    begin.mockRestore();
    vi.useRealTimers();
  }
});
