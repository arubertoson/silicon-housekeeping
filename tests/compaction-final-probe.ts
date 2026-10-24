// Offline integration against the exact activated source, under either SDK.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SessionManager, SettingsManager, type SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { readObservation, resolveCompactionConfig } from "../support/compaction.ts";
import { compactionAttemptType } from "../support/compaction-observation.ts";
import { fixtureCheckpoint, withCodex } from "./compaction-observation-probe.ts";

export async function verifyFinalCompactionIntegration(): Promise<Record<string, unknown>> {
  const settings: unknown = JSON.parse(await readFile(new URL("../settings.json", import.meta.url), "utf8"));
  const resolved = resolveCompactionConfig(settings, { provider: "openai-codex", id: "gpt-6-luna" });
  assert.equal(resolved.kind, "valid");
  if (resolved.kind !== "valid") throw new Error(resolved.reason);
  const configuration = resolved.config;
  assert.equal(configuration.enabled, true);
  assert.equal(configuration.targetTokens, 156_000);
  assert.equal(configuration.idleMinFraction, 0.7);
  assert.equal(configuration.expiryLeadMs, 30_000);
  assert.equal(configuration.idleTimeout, undefined);
  assert.ok(settings && typeof settings === "object" && "compaction" in settings);
  assert.ok(settings.compaction && typeof settings.compaction === "object" && "keepRecentTokens" in settings.compaction);
  assert.equal(settings.compaction.keepRecentTokens, 24_000);
  assert.ok("enabled" in settings.compaction && settings.compaction.enabled === false);
  const native = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 24_000 } });
  assert.equal(native.getCompactionSettings().keepRecentTokens, 24_000);
  assert.equal(native.getCompactionSettings().enabled, false);

  const profilePolicy = {
    enabled: configuration.enabled,
    targetTokens: configuration.targetTokens,
    idleMinFraction: configuration.idleMinFraction,
    expiryLeadSeconds: configuration.expiryLeadMs / 1000,
  };
  const sourcePath = fileURLToPath(new URL("../extensions/compaction.ts", import.meta.url));
  assert.ok("extensions" in settings && Array.isArray(settings.extensions) && settings.extensions.includes(sourcePath));
  const checks: Record<string, unknown> = {};
  await withCodex({ extensionPath: sourcePath, keepRecentTokens: 24_000, compactionConfig: profilePolicy },
    async ({ loader }) => {
      const loaded = loader.getExtensions().extensions.find((extension) => extension.path === sourcePath);
      assert.ok(loaded?.handlers.has("session_before_compact"), "The exact active extension must load through Pi");
      checks.productionLoad = { loaded: true, activated: true, targetTokens: configuration.targetTokens,
        idleMinimumTokens: Math.ceil(configuration.targetTokens * configuration.idleMinFraction), keepRecentTokens: 24_000 };
    });

  for (const trigger of ["manual", "size", "expiry"] as const) {
    // Expiry uses a short synthetic lifetime/lead, never an inferred provider TTL.
    const policy = trigger === "expiry"
      ? { ...profilePolicy, enabled: true, idleTimeoutSeconds: 0.4, expiryLeadSeconds: 0.1 }
      : { ...profilePolicy, enabled: trigger !== "manual" };
    await withCodex({ extensionPath: sourcePath, keepRecentTokens: 24_000, historyMessages: 8,
      compactionConfig: policy, contextTokens: trigger === "expiry" ? 120_000 : 156_100, summaryText: fixtureCheckpoint },
      async ({ session, pi, ctx, bodies, loader, errors }) => {
        const loaded = loader.getExtensions().extensions.find((extension) => extension.path === sourcePath);
        assert.ok(loaded?.handlers.has("session_before_compact"));
        let boundary: string | undefined;
        const committed = new Promise<SessionCompactEvent>((resolve) => {
          pi().on("session_before_compact", (event) => { boundary = event.preparation.firstKeptEntryId; });
          pi().on("session_compact", (event) => { resolve(event); });
        });
        await session.prompt("Finish normally; do not execute tools or continue after the checkpoint.");
        if (trigger === "manual") await session.compact();
        const event = await committed;
        assert.equal(event.fromExtension, true);
        assert.equal(event.compactionEntry.summary, fixtureCheckpoint);
        assert.equal(event.compactionEntry.firstKeptEntryId, boundary);
        assert.deepEqual(session.agent.state.messages, session.sessionManager.buildSessionProjection().messages);
        assert.ok(session.sessionFile);
        assert.deepEqual(SessionManager.open(session.sessionFile).buildSessionProjection(), session.sessionManager.buildSessionProjection());
        assert.equal(readObservation(ctx()).lastAttempt?.outcome, "committed");
        const outcome = session.sessionManager.getBranch().findLast((entry) =>
          entry.type === "custom" && entry.customType === compactionAttemptType);
        assert.ok(outcome?.type === "custom" && outcome.data && typeof outcome.data === "object" && "trigger" in outcome.data);
        assert.equal(outcome.data.trigger, trigger);
        assert.equal(bodies.length, 2, "One main request and one checkpoint; no continuation or fallback");
        assert.match(JSON.stringify(bodies[1]), /current-state handoff, not a changelog/);
        assert.deepEqual(errors, []);
        checks[trigger] = { fileLoaded: true, committed: true, reopened: true, requests: bodies.length,
          keepRecentTokens: 24_000, syntheticUsage: true, liveCacheMeasured: false };
      });
  }

  let reload = async () => {};
  await withCodex({ extensionPath: sourcePath, keepRecentTokens: 24_000, historyMessages: 8,
    compactionConfig: { ...profilePolicy, enabled: false }, summaryText: fixtureCheckpoint,
    beforeCheckpointReply: () => reload() }, async ({ session, ctx, bodies, loader, errors }) => {
      await session.prompt("Preserve this context if the checkpoint is interrupted by reload.");
      const before = session.sessionManager.buildSessionProjection().messages;
      const oldContext = ctx();
      reload = async () => { await session.reload(); };
      await assert.rejects(session.compact(), /Compaction cancelled/);
      assert.throws(() => oldContext.hasUI, /stale/i);
      assert.deepEqual(session.sessionManager.buildSessionProjection().messages, before);
      assert.equal(session.sessionManager.getEntries().some((entry) => entry.type === "compaction"), false);
      assert.ok(loader.getExtensions().extensions.find((extension) =>
        extension.path === sourcePath)?.handlers.has("session_before_compact"));
      // Let the new runtime's deferred disabled-policy check finish while ctx is valid.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(bodies.length, 2);
      assert.deepEqual(errors, []);
      checks.reload = { reloaded: true, cancelled: true, contextPreserved: true, requests: bodies.length };
    });
  return checks;
}
