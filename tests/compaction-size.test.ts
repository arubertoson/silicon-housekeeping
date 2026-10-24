import assert from "node:assert/strict";
import type { SessionCompactEvent, SessionCompactFailedEvent } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import compactionExtension from "../extensions/compaction.ts";
import { decideCompaction, defaultCompactionConfig, readObservation, sizeTargetTokens } from "../support/compaction.ts";
import { compactionAttemptType, type CompactionObservation } from "../support/compaction-observation.ts";
import { fixtureCheckpoint, withCodex } from "./compaction-observation-probe.ts";

const configuration = { ...defaultCompactionConfig, enabled: true };

const candidate: CompactionObservation = {
  requestId: "request",
  evidenceFingerprint: "a".repeat(64),
  eligibility: { kind: "candidate", reason: "on-payload-verification-required" },
};

function decision(observation = candidate, tokens: number | null = sizeTargetTokens) {
  return decideCompaction({ observation, configuration, contextUsage: { tokens, contextWindow: 272_000, percent: null }, now: 0 });
}

it("uses the soft size target, not expiry or context-window overflow", () => {
  expect(decision(candidate, sizeTargetTokens - 1)).toEqual({ kind: "skip", reason: "below-size-target" });
  expect(decision()).toEqual({ kind: "compact", trigger: "size" });
  expect(decision({ eligibility: { kind: "unavailable", reason: "no-cache-evidence" } })).toEqual({ kind: "skip", reason: "no-cache-evidence" });
});

it("does not infer size when context usage is unknown", () => {
  expect(decision(candidate, null)).toEqual({ kind: "skip", reason: "unknown-context-usage" });
  expect(decideCompaction({ observation: candidate, configuration, contextUsage: undefined, now: 0 })).toEqual({ kind: "skip", reason: "unknown-context-usage" });
});

it("suppresses unchanged failures and cancellations but permits changed evidence", () => {
  expect(decision({ ...candidate, lastAttempt: {
    requestId: "request", evidenceFingerprint: candidate.evidenceFingerprint, outcome: "started",
  } })).toEqual({ kind: "skip", reason: "unfinished-attempt-evidence" });
  for (const outcome of ["failed", "cancelled"] as const) {
    const observation: CompactionObservation = {
      ...candidate,
      lastAttempt: { requestId: "request", evidenceFingerprint: candidate.evidenceFingerprint, outcome },
    };
    expect(decision(observation)).toEqual({ kind: "skip", reason: "unchanged-failed-evidence" });
    expect(decision({ ...observation, evidenceFingerprint: "b".repeat(64) })).toEqual({ kind: "compact", trigger: "size" });
    expect(decision({ ...observation, requestId: "new-request" })).toEqual({ kind: "compact", trigger: "size" });
  }
});

it("commits the isolated idle size path through Pi without interrupting or continuing the task", async () => {
  await withCodex({ extension: compactionExtension, compactionConfig: { enabled: true }, contextTokens: sizeTargetTokens + 100, summaryText: fixtureCheckpoint },
    async ({ session, pi, ctx, bodies, errors }) => {
      const events: string[] = [];
      session.subscribe((event) => { events.push(event.type); });
      const committed = new Promise<SessionCompactEvent>((resolve) => {
        pi().on("session_compact", (event) => { resolve(event); });
      });
      await session.prompt("Finish this turn normally before any size-triggered checkpoint.");
      const event = await committed;
      assert.equal(event.fromExtension, true);
      assert.equal(event.compactionEntry.summary, fixtureCheckpoint);
      assert.ok(events.indexOf("agent_end") >= 0 && events.indexOf("agent_end") < events.indexOf("compaction_start"));
      assert.deepEqual(session.agent.state.messages, session.sessionManager.buildSessionProjection().messages);
      assert.equal(readObservation(ctx()).lastAttempt?.outcome, "committed");
      const record = session.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === compactionAttemptType);
      assert.ok(record?.type === "custom" && record.data && typeof record.data === "object" && "trigger" in record.data);
      assert.equal(record.data.trigger, "size");
      assert.equal(bodies.length, 2, "One settled agent request and one checkpoint, with no task continuation");
      assert.deepEqual(errors, []);
    });
}, 10_000);

it("releases preparation failures through shared outcomes and suppresses unchanged size retries", async () => {
  await withCodex({ extension: compactionExtension, compactionConfig: { enabled: true }, contextTokens: sizeTargetTokens + 100, keepRecentTokens: 500_000 },
    async ({ session, pi, ctx, bodies, errors }) => {
      const failed = new Promise<SessionCompactFailedEvent>((resolve) => {
        pi().on("session_compact_failed", (event) => { resolve(event); });
      });
      await session.prompt("This entire small fixture must be retained, so preparation has nothing to summarize.");
      const event = await failed;
      assert.match(event.errorMessage ?? "", /Nothing to compact/);
      const observation = readObservation(ctx());
      assert.equal(observation.lastAttempt?.outcome, "failed");
      assert.deepEqual(decideCompaction({ observation, configuration, contextUsage: ctx().getContextUsage(), now: 0 }), {
        kind: "skip", reason: "unchanged-failed-evidence",
      });
      // A visible source change extends the same warm request but is new evidence.
      session.sessionManager.appendMessage({ role: "user", content: "New context after the failed attempt", timestamp: Date.now() });
      const changed = readObservation(ctx());
      assert.equal(changed.requestId, observation.requestId);
      assert.notEqual(changed.evidenceFingerprint, observation.evidenceFingerprint);
      assert.deepEqual(decideCompaction({ observation: changed, configuration, contextUsage: ctx().getContextUsage(), now: 0 }), { kind: "compact", trigger: "size" });
      assert.equal(bodies.length, 1, "Preparation failure sends neither a summary nor a continuation");
      assert.deepEqual(errors, []);
    });
}, 10_000);

it("cancels an idle size extraction without replacement or unchanged automatic retry", async () => {
  let interrupt = () => {};
  await withCodex({ extension: compactionExtension, compactionConfig: { enabled: true }, contextTokens: sizeTargetTokens + 100, summaryText: fixtureCheckpoint,
    beforeCheckpointReply: () => interrupt() }, async ({ session, pi, ctx, bodies, errors }) => {
    let before: ReturnType<typeof session.sessionManager.buildSessionProjection>["messages"] | undefined;
    const interrupted = new Promise<void>((resolve, reject) => {
      interrupt = () => {
        before = session.sessionManager.buildSessionProjection().messages;
        session.abort().then(resolve, reject);
      };
    });
    const failed = new Promise<SessionCompactFailedEvent>((resolve) => {
      pi().on("session_compact_failed", (event) => { resolve(event); });
    });
    await session.prompt("Finish normally before the idle size extraction is cancelled.");
    const event = await failed;
    await interrupted;
    assert.equal(event.aborted, true);
    assert.deepEqual(session.sessionManager.buildSessionProjection().messages, before);
    const observation = readObservation(ctx());
    assert.equal(observation.lastAttempt?.outcome, "cancelled");
    assert.deepEqual(decideCompaction({ observation, configuration, contextUsage: ctx().getContextUsage(), now: 0 }), {
      kind: "skip", reason: "unchanged-failed-evidence",
    });
    assert.equal(bodies.length, 2, "No fallback or task continuation after cancellation");
    assert.deepEqual(errors, []);
  });
}, 10_000);
