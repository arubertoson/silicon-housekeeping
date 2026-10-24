import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { dispose, invalidate, scheduleCheck, suspend, type CompactionState } from "../support/compaction-state.ts";
import type { RequestCapture } from "../support/compaction-observation.ts";

// Cleanup must not consult ctx, including when a runtime has invalidated it.
const staleContext = new Proxy({} as ExtensionContext, { get() { throw new Error("stale context"); } });
afterEach(() => vi.useRealTimers());

it("replaces its only timer and defers immediate checks until the handler returns", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const state: CompactionState = { generation: 0 };
  const obsolete = vi.fn();
  const check = vi.fn(() => expect(state.timer).toBeUndefined());
  scheduleCheck(state, 2000, obsolete);
  scheduleCheck(state, 1000, check);
  expect(vi.getTimerCount()).toBe(1);
  expect(check).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(obsolete).not.toHaveBeenCalled();
  expect(check).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for a distant deadline without overflowing setTimeout or deciding policy early", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const state: CompactionState = { generation: 0 };
  const check = vi.fn();
  scheduleCheck(state, 2_147_483_700, check);
  await vi.advanceTimersByTimeAsync(2_147_483_647);
  expect(check).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(53);
  expect(check).toHaveBeenCalledOnce();
});

it("suspends and invalidates captured requests, extraction, and old timers without stale ctx access", async () => {
  vi.useFakeTimers();
  const capture: RequestCapture = {
    id: "capture", sessionId: "session", sourceEntryId: "entry", transcriptFingerprint: "hash", modelFingerprint: "hash",
    model: { provider: "openai-codex", api: "openai-codex-responses", id: "fixture" }, sdkVersion: "fixture", observedAt: 0, status: "pending",
  };
  const controller = new AbortController();
  const aborted = vi.fn();
  controller.signal.addEventListener("abort", aborted);
  const attempt = { id: "attempt", sessionId: "session", generation: 0, trigger: "manual" as const, controller, phase: "extracting" as const };
  const state: CompactionState = { generation: 0, pendingRequest: capture, attempt };
  const check = vi.fn();
  scheduleCheck(state, Date.now(), check);
  suspend(state, staleContext);
  const suspendedGeneration = state.generation;
  invalidate(state, staleContext);
  expect(state.generation).toBe(suspendedGeneration);
  expect(state.generation).toBeGreaterThan(0);
  expect(capture.status).toBe("invalidated");
  expect(state.pendingRequest).toBeUndefined();
  expect(state.timer).toBeUndefined();
  expect(controller.signal.aborted).toBe(true);
  expect(aborted).toHaveBeenCalledOnce();
  expect(state.attempt).toBe(attempt); // Shared terminal events still own release.
  await vi.runAllTimersAsync();
  expect(check).not.toHaveBeenCalled();
  dispose(state, staleContext);
  const generation = state.generation;
  dispose(state, staleContext);
  suspend(state, staleContext);
  expect(state.generation).toBe(generation);
  expect(state.attempt).toBeUndefined();
  expect(state.disposed).toBe(true);
  scheduleCheck(state, Date.now(), check);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not execute a timer whose captured generation is no longer current", async () => {
  vi.useFakeTimers();
  const state: CompactionState = { generation: 0 };
  const check = vi.fn();
  scheduleCheck(state, Date.now(), check);
  state.generation++;
  await vi.runAllTimersAsync();
  expect(check).not.toHaveBeenCalled();
  dispose(state, staleContext);
  expect(state.timer).toBeUndefined();
});

it("rejects nonfinite check times without leaving an earlier timer armed", () => {
  vi.useFakeTimers();
  const state: CompactionState = { generation: 0 };
  scheduleCheck(state, Date.now() + 1000, vi.fn());
  expect(() => scheduleCheck(state, NaN, vi.fn())).toThrow(RangeError);
  expect(state.timer).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
