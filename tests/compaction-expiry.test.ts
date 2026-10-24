import assert from "node:assert/strict";
import type { SessionCompactEvent, SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

import compactionExtension from "../extensions/compaction.ts";
import { decideCompaction, defaultCompactionConfig, readObservation, resolveCompactionConfig } from "../support/compaction.ts";
import { compactionAttemptType, type CompactionObservation } from "../support/compaction-observation.ts";
import { fixtureCheckpoint, withCodex } from "./compaction-observation-probe.ts";

afterEach(() => vi.unstubAllEnvs());
const configuration = { ...defaultCompactionConfig, enabled: true, targetTokens: 1000, expiryLeadMs: 1000 };
const candidate: CompactionObservation = {
  requestId: "request", evidenceFingerprint: "a".repeat(64),
  eligibility: { kind: "candidate", reason: "on-payload-verification-required" },
};
const cache: NonNullable<CompactionObservation["cache"]> = {
  expiresAt: 10_000, refreshedAt: 0, lifetimeMs: 10_000, source: "global-override", refreshSource: "request",
};
function decide(observation: CompactionObservation, tokens = 700, now = 9000) {
  return decideCompaction({ observation, contextUsage: { tokens, contextWindow: 2000, percent: null }, configuration, now });
}

it("uses expiry only for sufficiently large contexts with an unexpired known deadline", () => {
  expect(decide(candidate)).toEqual({ kind: "skip", reason: "below-size-target" });
  expect(decide({ ...candidate, cache }, 699)).toEqual({ kind: "skip", reason: "below-idle-minimum" });
  expect(decide({ ...candidate, cache }, 700, 8000)).toEqual({ kind: "wait", checkAt: 9000 });
  expect(decide({ ...candidate, cache })).toEqual({ kind: "compact", trigger: "expiry" });
  expect(decide({ ...candidate, cache }, 1000, 10_000)).toEqual({ kind: "skip", reason: "cache-deadline-passed" });
  expect(decideCompaction({ observation: candidate, configuration: defaultCompactionConfig,
    contextUsage: { tokens: 200_000, contextWindow: 272_000, percent: null }, now: 0 })).toEqual({ kind: "skip", reason: "auto-compaction-disabled" });
});

it("defers again when refreshed cache evidence moves the deadline", () => {
  expect(decide({ ...candidate, cache: { ...cache, refreshedAt: 10_000, expiresAt: 20_000, refreshSource: "cache-warm" } }, 700, 9000))
    .toEqual({ kind: "wait", checkAt: 19_000 });
});

it("does not carry a known deadline across a different model or active branch", async () => {
  vi.stubEnv("PI_CACHE_RETENTION", "short");
  await withCodex({ promptCache: { short: 300 } }, async ({ session, ctx, observations, bodies }) => {
    await session.prompt("Capture a known cache lifetime on this branch and model.");
    assert.ok(readObservation(ctx()).cache);
    const changedModel = new Proxy(ctx(), { get(target, key) {
      return key === "model" ? { ...target.model, id: "different-model" } : Reflect.get(target, key);
    } });
    const changed = readObservation(changedModel);
    assert.deepEqual(decide(changed), { kind: "skip", reason: "different-model-configuration" });
    session.sessionManager.branch(observations[0].sourceEntryId);
    const branch = readObservation(ctx());
    assert.equal(branch.cache, undefined);
    assert.deepEqual(decide(branch), { kind: "skip", reason: "no-request-observation" });
    assert.equal(bodies.length, 1);
  });
});

it("rereads Pi cache-warm usage at the original timer and commits only near the refreshed deadline", async () => {
  vi.stubEnv("PI_CACHE_RETENTION", "short");
  await withCodex({ extension: compactionExtension, contextTokens: 80_000, summaryText: fixtureCheckpoint,
    promptCache: { short: 2 }, compactionConfig: { enabled: true, expiryLeadSeconds: 1 } },
    async ({ session, pi, ctx, bodies, errors }) => {
      let startedAt = 0;
      session.subscribe((event) => { if (event.type === "compaction_start") startedAt = Date.now(); });
      const committed = new Promise<SessionCompactEvent>((resolve) => { pi().on("session_compact", (event) => { resolve(event); }); });
      await session.prompt("Finish normally; the context is below the size target but above the idle minimum.");
      const initial = readObservation(ctx());
      assert.ok(initial.cache);
      assert.equal(initial.cache.source, "pi-model-metadata");
      assert.equal(initial.cache.refreshSource, "request");
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      const reply = session.messages.findLast((message) => message.role === "assistant");
      assert.ok(reply?.role === "assistant");
      const warm = session.sessionManager.appendUsage("cache_warm", "openai-codex", "gpt-5.4", reply.usage);
      const refreshed = readObservation(ctx());
      assert.ok(refreshed.cache);
      assert.equal(refreshed.cache.refreshedAt, Date.parse(warm.timestamp));
      assert.equal(refreshed.cache.refreshSource, "cache-warm");
      assert.notEqual(refreshed.evidenceFingerprint, initial.evidenceFingerprint);
      const event = await committed;
      assert.ok(startedAt >= Date.parse(warm.timestamp) + 1000, "The old timer must reread the extended deadline, not mandate compaction");
      assert.equal(event.compactionEntry.summary, fixtureCheckpoint);
      const outcome = session.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === compactionAttemptType);
      assert.ok(outcome?.type === "custom" && outcome.data && typeof outcome.data === "object" && "trigger" in outcome.data);
      assert.equal(outcome.data.trigger, "expiry");
      assert.equal(bodies.length, 2, "One main request and one checkpoint, without continuation");
      assert.deepEqual(errors, []);
    });
}, 10_000);

it("cancels the expiry path when native serialization cannot reproduce the captured prefix", async () => {
  await withCodex({ extension: compactionExtension, contextTokens: 80_000, summaryText: fixtureCheckpoint,
    compactionConfig: { enabled: true, idleTimeoutSeconds: 1, expiryLeadSeconds: 0.5 },
    beforeObserver: (pi) => {
      pi.on("before_provider_request", (event) => {
        assert.ok(event.payload && typeof event.payload === "object");
        return { ...event.payload, instructions: "MAIN_REQUEST_ONLY_INSTRUCTIONS" };
      });
    } }, async ({ session, pi, ctx, bodies, errors }) => {
    const failed = new Promise<SessionCompactFailedEvent>((resolve) => { pi().on("session_compact_failed", (event) => { resolve(event); }); });
    await session.prompt("Finish before checking the mismatched prefix at the expiry deadline.");
    const before = session.sessionManager.buildSessionProjection().messages;
    const event = await failed;
    assert.equal(event.aborted, true);
    assert.deepEqual(session.sessionManager.buildSessionProjection().messages, before);
    const resolved = resolveCompactionConfig(pi().getSettings(), ctx().model);
    assert.equal(resolved.kind, "valid");
    if (resolved.kind !== "valid") throw new Error(resolved.reason);
    const observation = readObservation(ctx(), resolved.config);
    assert.equal(observation.lastAttempt?.outcome, "failed");
    assert.equal(bodies.length, 1, "No mismatched request, default summarizer, or continuation is sent");
    assert.deepEqual(errors, []);
  });
}, 10_000);
