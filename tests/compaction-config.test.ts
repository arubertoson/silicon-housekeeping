import { expect, it } from "vitest";
import { defaultCompactionConfig, resolveCacheLifetime, resolveCompactionConfig } from "../support/compaction-config.ts";

const model = { provider: "openai-codex", id: "gpt-6-luna" };

function resolve(value: unknown, identity = model) {
  const result = resolveCompactionConfig({ cacheAwareCompaction: value }, identity);
  if (result.kind === "invalid") throw new Error(result.reason);
  return result.config;
}

it("defaults automatic compaction off and inherits fields through provider/model overrides", () => {
  expect(resolve(undefined)).toEqual(defaultCompactionConfig);
  const settings = {
    enabled: true, targetTokens: 100_000, idleTimeoutSeconds: 300,
    providers: {
      "openai-codex": {
        targetTokens: 120_000, idleTimeoutSeconds: 600,
        models: { "gpt-6-luna": { idleMinFraction: 0.75, idleTimeoutSeconds: 900 } },
      },
    },
  };
  expect(resolve(settings)).toEqual({ enabled: true, targetTokens: 120_000, idleMinFraction: 0.75, expiryLeadMs: 30_000,
    idleTimeout: { seconds: 900, source: "model-override" } });
  expect(resolve(settings, { ...model, id: "other" }).idleTimeout).toEqual({ seconds: 600, source: "provider-override" });
  expect(resolve(settings, { provider: "another-provider", id: model.id }).idleTimeout).toEqual({ seconds: 300, source: "global-override" });
});

it("uses Pi's active retention tier only when no explicit lifetime overrides it", () => {
  expect(resolveCacheLifetime(resolve({}), { short: 300, long: 3600 }, "short")).toEqual({ ms: 300_000, source: "pi-model-metadata" });
  expect(resolveCacheLifetime(resolve({}), { short: 300, long: 3600 }, "long")).toEqual({ ms: 3_600_000, source: "pi-model-metadata" });
  expect(resolveCacheLifetime(resolve({}), { short: 300 }, "long")).toBeUndefined();
  expect(resolveCacheLifetime(resolve({}), { short: 300 }, undefined)).toBeUndefined();
  expect(resolveCacheLifetime(resolve({ idleTimeoutSeconds: 120 }), { short: 300 }, "short")).toEqual({ ms: 120_000, source: "global-override" });
});

it("honors explicit model disables without falling back to provider or Pi defaults", () => {
  const config = resolve({ enabled: true, idleTimeoutSeconds: 300, providers: {
    "openai-codex": { models: { "gpt-6-luna": { enabled: false, idleTimeoutSeconds: null } } },
  } });
  expect(config.enabled).toBe(false);
  expect(resolveCacheLifetime(config, { short: 300 }, "short")).toBeUndefined();
});

it("rejects malformed configuration instead of silently choosing a fallback", () => {
  for (const value of [null, { enabled: "yes" }, { idleMinFraction: 1.1 }, { idleTimeoutSeconds: 0 },
    { targetTokens: -1 }, { expiryLeadSeconds: NaN }, { providers: [] }, { misspelled: true }]) {
    const result = resolveCompactionConfig({ cacheAwareCompaction: value }, model);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.reason).not.toBe("");
  }
});
