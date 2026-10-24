import { describe, it } from "vitest";
import { compactionObservationCases } from "./compaction-observation-probe.ts";

describe("session-backed compaction request observations (native Codex, loopback HTTP)", () => {
  for (const [name, run] of Object.entries(compactionObservationCases)) {
    it(name, async () => { await run(); }, 10_000);
  }
});
