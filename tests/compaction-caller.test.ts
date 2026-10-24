import type {
  ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

vi.mock("../support/compaction-draft.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../support/compaction-draft.ts")>(),
  // Registration only inside this test; the on-disk extension stays inactive.
  compactionImplemented: true,
  generateCheckpoint: vi.fn(async () => { throw new Error("Extraction rejected after reload"); }),
}));
import compactionExtension from "../extensions/compaction.ts";

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

it("keeps the real draft inactive", async () => {
  const draft = await vi.importActual<typeof import("../support/compaction-draft.ts")>("../support/compaction-draft.ts");
  expect(draft.compactionImplemented).toBe(false);
});
