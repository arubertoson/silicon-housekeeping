import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RequestCapture } from "./compaction-observation.ts";

// One extension-owned coordinator; conversations and decision inputs stay in Pi.
export interface CompactionState {
  generation: number;
  disposed?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  pendingRequest?: RequestCapture;
  attempt?: {
    readonly id: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly trigger: "size" | "expiry" | "manual";
    readonly controller: AbortController;
    readonly requestId?: string;
    readonly evidenceFingerprint?: string;
    phase: "requested" | "extracting" | "ready" | "rejected";
    failureOutcome?: "failed" | "cancelled";
    errorMessage?: string;
  };
}

export function scheduleCheck(state: CompactionState, checkAt: number, check: () => void): void {
  clearTimeout(state.timer);
  state.timer = undefined;
  if (state.disposed) return;
  if (!Number.isFinite(checkAt)) {
    throw new RangeError("Compaction check time must be finite");
  }

  const generation = state.generation;

  function arm(): void {
    // Avoid setTimeout's overflow-to-1ms behavior without checking policy early.
    const timer = setTimeout(() => {
      if (state.disposed || state.generation !== generation || state.timer !== timer) return;
      state.timer = undefined;
      if (Date.now() < checkAt) {
        arm();
      } else {
        check();
      }
    }, Math.min(2_147_483_647, Math.max(0, checkAt - Date.now())));
    state.timer = timer;
  }

  arm();
}

export function suspend(state: CompactionState, _ctx: ExtensionContext): void {
  const activeTimer = state.timer !== undefined;
  const activeCapture = state.pendingRequest?.status === "pending";
  const activeExtraction = state.attempt && !state.attempt.controller.signal.aborted;

  clearTimeout(state.timer);
  state.timer = undefined;
  if (state.pendingRequest) {
    state.pendingRequest.status = "invalidated";
  }
  state.pendingRequest = undefined;

  if (state.disposed) return;
  if (activeTimer || activeCapture || activeExtraction) {
    state.generation++;
  }
  state.attempt?.controller.abort();
  // Keep a canceled attempt owned until its terminal event releases it.
}

export function invalidate(state: CompactionState, ctx: ExtensionContext): void {
  suspend(state, ctx);
  // Eligibility is reconstructed from the active branch/model, never cached here.
}

export function dispose(state: CompactionState, ctx: ExtensionContext): void {
  if (state.disposed) return;
  suspend(state, ctx);
  state.disposed = true;
  state.attempt = undefined;
  // Do not read ctx: reload/disposal can already have made it stale.
}
