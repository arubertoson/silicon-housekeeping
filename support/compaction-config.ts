import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type OverrideSource = "global-override" | "provider-override" | "model-override";
export type CacheLifetimeSource = OverrideSource | "pi-model-metadata";
export type CacheRetention = "short" | "long";

export interface CompactionConfig {
  readonly enabled: boolean;
  readonly targetTokens: number;
  readonly idleMinFraction: number;
  readonly expiryLeadMs: number;
  // Omitted inherits Pi metadata; null explicitly disables expiry scheduling.
  readonly idleTimeout?: { readonly seconds: number | null; readonly source: OverrideSource };
}

export const sizeTargetTokens = 100_000;
export const defaultCompactionConfig: CompactionConfig = {
  enabled: false,
  targetTokens: sizeTargetTokens,
  idleMinFraction: 0.7,
  expiryLeadMs: 30_000,
};

type ConfigResolution =
  | { readonly kind: "valid"; readonly config: CompactionConfig }
  | { readonly kind: "invalid"; readonly reason: string };

type ModelIdentity = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function selected(value: unknown, key: string | undefined, path: string): unknown {
  const entries = record(value, path);
  return key !== undefined && Object.hasOwn(entries, key) ? entries[key] : undefined;
}

function positiveSeconds(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value * 1000 > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${path} must be a positive finite number of seconds`);
  }
  return value;
}

// Extension-owned settings.json namespace. Fields inherit independently through
// cacheAwareCompaction -> providers[provider] -> models[model]. No file I/O here.
export function resolveCompactionConfig(settings: unknown, model: ModelIdentity | undefined): ConfigResolution {
  try {
    const root = record(record(settings, "settings").cacheAwareCompaction, "cacheAwareCompaction");
    const provider = record(selected(root.providers, model?.provider, "cacheAwareCompaction.providers"), "provider override");
    const modelOverride = record(selected(provider.models, model?.id, "provider.models"), "model override");
    const levels: { value: Record<string, unknown>; source: OverrideSource; nested?: string }[] = [
      { value: root, source: "global-override", nested: "providers" },
      { value: provider, source: "provider-override", nested: "models" },
      { value: modelOverride, source: "model-override" },
    ];
    let config = defaultCompactionConfig;
    for (const { value, source, nested } of levels) {
      const allowed = ["enabled", "targetTokens", "idleMinFraction", "idleTimeoutSeconds", "expiryLeadSeconds", nested];
      if (Object.keys(value).some((key) => !allowed.includes(key))) {
        throw new Error(`Unknown cacheAwareCompaction setting in ${source}`);
      }
      if (value.enabled !== undefined) {
        if (typeof value.enabled !== "boolean") throw new Error(`${source}.enabled must be a boolean`);
        config = { ...config, enabled: value.enabled };
      }
      if (value.targetTokens !== undefined) {
        if (typeof value.targetTokens !== "number" || !Number.isSafeInteger(value.targetTokens) || value.targetTokens <= 0) {
          throw new Error(`${source}.targetTokens must be a positive safe integer`);
        }
        config = { ...config, targetTokens: value.targetTokens };
      }
      if (value.idleMinFraction !== undefined) {
        if (typeof value.idleMinFraction !== "number" || !Number.isFinite(value.idleMinFraction) || value.idleMinFraction <= 0 || value.idleMinFraction > 1) {
          throw new Error(`${source}.idleMinFraction must be greater than zero and at most one`);
        }
        config = { ...config, idleMinFraction: value.idleMinFraction };
      }
      if (value.expiryLeadSeconds !== undefined) {
        config = { ...config, expiryLeadMs: positiveSeconds(value.expiryLeadSeconds, `${source}.expiryLeadSeconds`) * 1000 };
      }
      if (value.idleTimeoutSeconds !== undefined) {
        const seconds = value.idleTimeoutSeconds === null ? null
          : positiveSeconds(value.idleTimeoutSeconds, `${source}.idleTimeoutSeconds`);
        config = { ...config, idleTimeout: { seconds, source } };
      }
    }
    return { kind: "valid", config };
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : "Invalid cacheAwareCompaction configuration" };
  }
}

// Pi's declared tier is a best-effort lifetime, not a provider countdown. An old
// observation without its retention tier cannot establish this fallback.
export function resolveCacheLifetime(
  config: CompactionConfig,
  promptCache: Readonly<Partial<Record<CacheRetention, number>>> | undefined,
  retention: CacheRetention | undefined,
): { readonly ms: number; readonly source: CacheLifetimeSource } | undefined {
  if (config.idleTimeout) {
    if (config.idleTimeout.seconds === null) return undefined;
    return { ms: config.idleTimeout.seconds * 1000, source: config.idleTimeout.source };
  }
  const seconds = retention === undefined ? undefined : promptCache?.[retention];
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return { ms: seconds * 1000, source: "pi-model-metadata" };
}
