import { createHash, randomUUID } from "node:crypto";
import {
  buildSessionProjection,
  convertToLlm,
  VERSION,
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { defaultCompactionConfig, resolveCacheLifetime, type CacheLifetimeSource, type CacheRetention, type CompactionConfig } from "./compaction-config.ts";

export const requestObservationType = "compaction.request.v1";
export const compactionAttemptType = "compaction.attempt.v1";
type Messages = ContextWithSystemEvent["messages"];

const unavailableReasons = [
  "request-local-context",
  "unsupported-transport",
  "unsupported-payload-settings",
  "blocked-images",
  "custom-model-headers",
] as const;
type UnavailableReason = typeof unavailableReasons[number];

interface RequestIdentity {
  readonly id: string;
  readonly sessionId: string;
  readonly sourceEntryId: string;
  readonly transcriptFingerprint: string;
  readonly modelFingerprint: string;
  readonly model: {
    readonly provider: "openai-codex";
    readonly api: "openai-codex-responses";
    readonly id: string;
  };
  readonly sdkVersion: string;
  readonly observedAt: number;
}

export interface RequestCapture extends RequestIdentity {
  status: "pending" | "consumed" | "invalidated";
  readonly unavailableReason?: UnavailableReason;
}

interface CodexParameters {
  readonly reasoning?: { readonly effort: string; readonly summary?: string };
  readonly verbosity: "low" | "medium" | "high";
  readonly toolChoice: "auto" | "none" | "required";
  readonly temperature?: number;
  readonly serviceTier?: "auto" | "default" | "flex" | "priority";
}

export interface RequestObservation extends RequestIdentity {
  readonly transport: "sse" | "auto" | "websocket" | "websocket-cached" | "unknown";
  readonly parameters?: CodexParameters;
  readonly payloadFingerprint: string;
  readonly prefix: {
    readonly instructions: string;
    readonly tools: string;
    readonly input: string;
    readonly inputCount: number;
  };
  readonly unavailableReason?: UnavailableReason;
  // Capture at the same hook as pi-cached-compaction. The replay is checked in
  // its own onPayload callback; this metadata is not a wire observation.
  readonly provenance: "before_provider_request";
  readonly cache: {
    readonly lifetime: "unknown";
    readonly evidence: "serialized-session-cache-key";
    readonly retention?: CacheRetention;
  };
}

export interface CompactionObservation {
  readonly requestId?: string;
  readonly request?: RequestObservation;
  readonly evidenceFingerprint?: string;
  readonly eligibility:
    | { readonly kind: "candidate"; readonly reason: "on-payload-verification-required" }
    | { readonly kind: "unavailable"; readonly reason: string };
  readonly response?: {
    readonly entryId: string;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly stopReason: string;
  };
  readonly cache?: {
    readonly expiresAt: number;
    readonly lifetimeMs: number;
    readonly source: CacheLifetimeSource;
    readonly refreshedAt: number;
    readonly refreshSource: "request" | "cache-warm";
  };
  readonly lastAttempt?: {
    readonly requestId: string;
    readonly evidenceFingerprint?: string;
    readonly outcome: "started" | "committed" | "failed" | "cancelled";
  };
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

function supportedModel(ctx: ExtensionContext): boolean {
  return ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
}

function modelFingerprint(ctx: ExtensionContext): string {
  const model = ctx.model;
  if (!model) return fingerprint(null);
  // Hash only serialization-relevant configuration. Never copy credentials,
  // headers, arbitrary model properties, or endpoint strings into metadata.
  return fingerprint({
    provider: model.provider,
    api: model.api,
    id: model.id,
    baseUrl: model.baseUrl,
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
    reasoning: model.reasoning,
  });
}

export function observeRequest(ctx: ExtensionContext, messages: Messages): RequestCapture | undefined {
  if (!supportedModel(ctx)) return undefined;
  const sourceEntryId = ctx.sessionManager.getLeafId();
  if (!sourceEntryId || !ctx.model) return undefined;
  const transcriptFingerprint = fingerprint(convertToLlm(messages));
  const persistedMessages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
  return {
    id: randomUUID(),
    sessionId: ctx.sessionManager.getSessionId(),
    sourceEntryId,
    transcriptFingerprint,
    modelFingerprint: modelFingerprint(ctx),
    model: { provider: "openai-codex", api: "openai-codex-responses", id: ctx.model.id },
    sdkVersion: VERSION,
    observedAt: Date.now(),
    status: "pending",
    ...(transcriptFingerprint !== fingerprint(persistedMessages) ? { unavailableReason: "request-local-context" as const } : {}),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function nonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function fingerprintString(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function parseCodexParameters(payload: Record<string, unknown>): CodexParameters | undefined {
  const allowedFields = [
    "model", "store", "stream", "instructions", "input", "text", "include",
    "prompt_cache_key", "tool_choice", "parallel_tool_calls", "tools",
    "reasoning", "temperature", "service_tier",
  ];
  if (Object.keys(payload).some((key) => !allowedFields.includes(key))) return undefined;
  if (payload.store !== false || payload.stream !== true || payload.parallel_tool_calls !== true) return undefined;

  if (!object(payload.text) || Object.keys(payload.text).length !== 1) return undefined;
  if (!oneOf(payload.text.verbosity, ["low", "medium", "high"])) return undefined;
  if (!oneOf(payload.tool_choice, ["auto", "none", "required"])) return undefined;
  if (!Array.isArray(payload.include) || payload.include.length !== 1 || payload.include[0] !== "reasoning.encrypted_content") {
    return undefined;
  }

  let reasoning: CodexParameters["reasoning"];
  if (payload.reasoning !== undefined) {
    const value = payload.reasoning;
    if (!object(value)) return undefined;
    if (Object.keys(value).some((key) => key !== "effort" && key !== "summary")) return undefined;
    if (!oneOf(value.effort, ["none", "minimal", "low", "medium", "high", "xhigh", "max"])) return undefined;
    if (value.summary !== undefined && !oneOf(value.summary, ["auto", "concise", "detailed"])) return undefined;
    reasoning = {
      effort: value.effort,
      ...(value.summary === undefined ? {} : { summary: value.summary }),
    };
  }

  if (payload.temperature !== undefined && (!nonnegativeFiniteNumber(payload.temperature) || payload.temperature > 2)) {
    return undefined;
  }
  if (payload.service_tier !== undefined && !oneOf(payload.service_tier, ["auto", "default", "flex", "priority"])) {
    return undefined;
  }

  return {
    verbosity: payload.text.verbosity,
    toolChoice: payload.tool_choice,
    ...(reasoning ? { reasoning } : {}),
    ...(payload.temperature === undefined ? {} : { temperature: payload.temperature }),
    ...(payload.service_tier === undefined ? {} : { serviceTier: payload.service_tier }),
  };
}

// Called exactly once with the capture removed from state by the caller. An
// unrelated event consumes it too: ambiguity must not survive into another call.
export function observePayload(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  capture: RequestCapture,
  payload: unknown,
): RequestObservation | undefined {
  if (capture.status !== "pending") return undefined;
  capture.status = "consumed";

  if (!supportedModel(ctx)) return undefined;
  if (capture.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
  if (capture.sourceEntryId !== ctx.sessionManager.getLeafId()) return undefined;
  if (capture.modelFingerprint !== modelFingerprint(ctx)) return undefined;
  if (!object(payload) || payload.model !== capture.model.id || payload.prompt_cache_key !== capture.sessionId) return undefined;
  if (typeof payload.instructions !== "string" || !Array.isArray(payload.input)) return undefined;

  const settings = pi.getSettings();
  const replayParameters = parseCodexParameters(payload);
  const configuredTransport = settings.transport ?? "auto";
  const transport = oneOf(configuredTransport, ["sse", "auto", "websocket", "websocket-cached"])
    ? configuredTransport
    : "unknown";

  let unavailableReason = capture.unavailableReason;
  if (unavailableReason === undefined) {
    if (transport !== "sse") {
      unavailableReason = "unsupported-transport";
    } else if (settings.images?.blockImages) {
      unavailableReason = "blocked-images";
    } else if (Object.keys(ctx.model?.headers ?? {}).length > 0) {
      unavailableReason = "custom-model-headers";
    } else if (!replayParameters || (payload.tools !== undefined && !Array.isArray(payload.tools))) {
      unavailableReason = "unsupported-payload-settings";
    }
  }

  // Explicit allowlist: no messages, prompt/tool bodies, headers, tokens, unknown
  // settings, or a duplicate usage store. The branch already owns those inputs.
  const observation: RequestObservation = {
    id: capture.id,
    sessionId: capture.sessionId,
    sourceEntryId: capture.sourceEntryId,
    transcriptFingerprint: capture.transcriptFingerprint,
    modelFingerprint: capture.modelFingerprint,
    model: capture.model,
    sdkVersion: capture.sdkVersion,
    observedAt: capture.observedAt,
    transport,
    ...(replayParameters ? { parameters: replayParameters } : {}),
    payloadFingerprint: fingerprint(payload),
    prefix: {
      instructions: fingerprint(payload.instructions),
      tools: fingerprint(payload.tools),
      input: fingerprint(payload.input),
      inputCount: payload.input.length,
    },
    ...(unavailableReason ? { unavailableReason } : {}),
    provenance: "before_provider_request",
    cache: {
      lifetime: "unknown", evidence: "serialized-session-cache-key",
      // Pi's default retention tier at capture; no expiry is inferred here.
      retention: process.env.PI_CACHE_RETENTION === "long" ? "long" : "short",
    },
  };
  pi.appendEntry(requestObservationType, observation);
  return observation;
}

function parseObservation(value: unknown): RequestObservation | undefined {
  if (!object(value)) return undefined;
  if (!identifier(value.id) || !identifier(value.sessionId) || !identifier(value.sourceEntryId)) return undefined;
  if (
    !fingerprintString(value.transcriptFingerprint) ||
    !fingerprintString(value.modelFingerprint) ||
    !fingerprintString(value.payloadFingerprint)
  ) {
    return undefined;
  }
  if (!identifier(value.sdkVersion) || !nonnegativeFiniteNumber(value.observedAt)) return undefined;

  if (!object(value.model)) return undefined;
  if (value.model.provider !== "openai-codex" || value.model.api !== "openai-codex-responses" || !identifier(value.model.id)) {
    return undefined;
  }
  if (!oneOf(value.transport, ["sse", "auto", "websocket", "websocket-cached", "unknown"])) return undefined;
  if (value.provenance !== "before_provider_request") return undefined;

  if (!object(value.prefix)) return undefined;
  if (
    !fingerprintString(value.prefix.instructions) ||
    !fingerprintString(value.prefix.tools) ||
    !fingerprintString(value.prefix.input)
  ) {
    return undefined;
  }
  if (!Number.isSafeInteger(value.prefix.inputCount) || !nonnegativeFiniteNumber(value.prefix.inputCount)) return undefined;
  if (!object(value.cache) || value.cache.lifetime !== "unknown" || value.cache.evidence !== "serialized-session-cache-key") {
    return undefined;
  }
  if (value.cache.retention !== undefined && !oneOf(value.cache.retention, ["short", "long"])) return undefined;
  if (value.unavailableReason !== undefined && !oneOf(value.unavailableReason, unavailableReasons)) return undefined;

  let replayParameters: CodexParameters | undefined;
  if (value.parameters !== undefined) {
    const persistedParameters = value.parameters;
    if (!object(persistedParameters)) return undefined;
    // Reuse the provider-parameter allowlist, rather than trusting session JSON.
    replayParameters = parseCodexParameters({
      model: value.model.id,
      store: false,
      stream: true,
      parallel_tool_calls: true,
      text: { verbosity: persistedParameters.verbosity },
      tool_choice: persistedParameters.toolChoice,
      include: ["reasoning.encrypted_content"],
      reasoning: persistedParameters.reasoning,
      temperature: persistedParameters.temperature,
      service_tier: persistedParameters.serviceTier,
    });
    if (!replayParameters) return undefined;
  }
  if (!replayParameters && value.unavailableReason === undefined) return undefined;

  return {
    id: value.id,
    sessionId: value.sessionId,
    sourceEntryId: value.sourceEntryId,
    transcriptFingerprint: value.transcriptFingerprint,
    modelFingerprint: value.modelFingerprint,
    payloadFingerprint: value.payloadFingerprint,
    model: { provider: "openai-codex", api: "openai-codex-responses", id: value.model.id },
    sdkVersion: value.sdkVersion,
    observedAt: value.observedAt,
    transport: value.transport,
    ...(replayParameters ? { parameters: replayParameters } : {}),
    prefix: {
      instructions: value.prefix.instructions,
      tools: value.prefix.tools,
      input: value.prefix.input,
      inputCount: value.prefix.inputCount,
    },
    ...(value.unavailableReason === undefined ? {} : { unavailableReason: value.unavailableReason }),
    provenance: "before_provider_request",
    cache: {
      lifetime: "unknown", evidence: "serialized-session-cache-key",
      ...(value.cache.retention === undefined ? {} : { retention: value.cache.retention }),
    },
  };
}

export type RequestReconstruction =
  | {
      readonly kind: "candidate";
      readonly request: RequestObservation;
      readonly messages: ReturnType<typeof convertToLlm>;
      readonly verification: "on-payload-verification-required";
    }
  | { readonly kind: "unavailable"; readonly reason: string };

export function reconstructRequest(ctx: ExtensionContext, request: RequestObservation): RequestReconstruction {
  const unavailable = (reason: string): RequestReconstruction => ({ kind: "unavailable", reason });
  if (request.sessionId !== ctx.sessionManager.getSessionId()) return unavailable("different-session");
  if (request.sdkVersion !== VERSION) return unavailable("different-serializer-version");
  if (!supportedModel(ctx) || request.modelFingerprint !== modelFingerprint(ctx)) {
    return unavailable("different-model-configuration");
  }
  if (Object.keys(ctx.model?.headers ?? {}).length) return unavailable("custom-model-headers");
  if (request.unavailableReason) return unavailable(request.unavailableReason);
  if (request.transport !== "sse") return unavailable("unsupported-transport");
  if (!request.parameters) return unavailable("unsupported-payload-settings");

  const branch = ctx.sessionManager.getBranch();
  const sourceIndex = branch.findIndex((entry) => entry.id === request.sourceEntryId);
  if (sourceIndex < 0) return unavailable("source-not-on-active-branch");

  const sourceProjection = buildSessionProjection(branch.slice(0, sourceIndex + 1));
  const messages = convertToLlm(sourceProjection.messages);
  if (fingerprint(messages) !== request.transcriptFingerprint) return unavailable("source-fingerprint-mismatch");

  const currentProjection = ctx.sessionManager.buildSessionProjection();
  if (sourceProjection.thinkingLevel !== currentProjection.thinkingLevel) {
    return unavailable("different-thinking-level");
  }
  const currentMessages = convertToLlm(currentProjection.messages);
  if (
    messages.length > currentMessages.length ||
    messages.some((message, index) => fingerprint(message) !== fingerprint(currentMessages[index]))
  ) {
    return unavailable("context-no-longer-extends-request");
  }

  // Match this capture against the replay's provider serialization before send,
  // following pi-cached-compaction. Compatibility does not prove a cache hit.
  return { kind: "candidate", request, messages, verification: "on-payload-verification-required" };
}

export function readObservation(ctx: ExtensionContext, config: CompactionConfig = defaultCompactionConfig): CompactionObservation {
  const unavailable = (reason: string): CompactionObservation => ({ eligibility: { kind: "unavailable", reason } });
  if (!supportedModel(ctx)) return unavailable("unsupported-provider-api");
  const branch = ctx.sessionManager.getBranch();
  const index = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === requestObservationType);
  if (index < 0) return unavailable("no-request-observation");
  const entry = branch[index];
  const request = entry.type === "custom" ? parseObservation(entry.data) : undefined;
  if (!request) return unavailable("invalid-request-metadata");

  const reconstructed = reconstructRequest(ctx, request);
  const response = responseAfter(branch.slice(index + 1), request);
  let eligibility: CompactionObservation["eligibility"];
  if (reconstructed.kind === "unavailable") {
    eligibility = { kind: "unavailable", reason: reconstructed.reason };
  } else if (!response) {
    eligibility = { kind: "unavailable", reason: "no-persisted-response" };
  } else if (response.stopReason === "error" || response.stopReason === "aborted") {
    eligibility = { kind: "unavailable", reason: "previous-request-failed" };
  } else if (response.cacheRead + response.cacheWrite === 0) {
    eligibility = { kind: "unavailable", reason: "no-cache-evidence" };
  } else {
    eligibility = { kind: "candidate", reason: "on-payload-verification-required" };
  }

  const cache = response && response.stopReason !== "error" && response.stopReason !== "aborted" && response.cacheRead + response.cacheWrite > 0
    ? cacheObservation(ctx, request, branch.slice(index + 1), config)
    : undefined;
  // Attempt records do not change this identity. Visible source changes do,
  // even when they still extend the same captured provider request.
  const evidenceFingerprint = fingerprint({
    requestId: request.id,
    responseEntryId: response?.entryId,
    context: fingerprint(convertToLlm(ctx.sessionManager.buildSessionProjection().messages)),
    cache,
  });
  const attemptEntry = branch.findLast((entry) =>
    entry.type === "custom" && entry.customType === compactionAttemptType && object(entry.data) &&
    entry.data.sessionId === request.sessionId && entry.data.requestId === request.id &&
    identifier(entry.data.attemptId) && oneOf(entry.data.outcome, ["started", "committed", "failed", "cancelled"]) &&
    (entry.data.evidenceFingerprint === undefined || fingerprintString(entry.data.evidenceFingerprint)),
  );
  const attemptData = attemptEntry?.type === "custom" && object(attemptEntry.data) ? attemptEntry.data : undefined;
  const outcome = attemptData?.outcome;

  return {
    requestId: request.id,
    request,
    evidenceFingerprint,
    eligibility,
    ...(response ? { response } : {}),
    ...(cache ? { cache } : {}),
    ...(oneOf(outcome, ["started", "committed", "failed", "cancelled"])
      ? { lastAttempt: {
          requestId: request.id,
          outcome,
          ...(fingerprintString(attemptData?.evidenceFingerprint) ? { evidenceFingerprint: attemptData.evidenceFingerprint } : {}),
        } }
      : {}),
  };
}

function cacheObservation(
  ctx: ExtensionContext,
  request: RequestObservation,
  entries: readonly SessionEntry[],
  config: CompactionConfig,
): CompactionObservation["cache"] {
  const lifetime = resolveCacheLifetime(config, ctx.model?.promptCache, request.cache.retention);
  if (!lifetime) return undefined;

  // The original request timestamp is conservative: the cache input was sent
  // before its response completed. Refresh usage is already persisted by Pi.
  let refreshedAt = request.observedAt;
  let refreshSource: "request" | "cache-warm" = "request";
  for (const entry of entries) {
    if (entry.type !== "usage" || entry.kind !== "cache_warm") continue;
    if (entry.provider !== request.model.provider || entry.model !== request.model.id) continue;
    if (!nonnegativeFiniteNumber(entry.usage?.cacheRead) || !nonnegativeFiniteNumber(entry.usage?.cacheWrite)) continue;
    if (entry.usage.cacheRead + entry.usage.cacheWrite === 0) continue;
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= refreshedAt || timestamp > Date.now()) continue;
    refreshedAt = timestamp;
    refreshSource = "cache-warm";
  }
  return {
    expiresAt: refreshedAt + lifetime.ms,
    lifetimeMs: lifetime.ms,
    source: lifetime.source,
    refreshedAt,
    refreshSource,
  };
}

function responseAfter(entries: readonly SessionEntry[], request: RequestObservation): CompactionObservation["response"] {
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === requestObservationType) return undefined;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (message.provider !== request.model.provider || message.model !== request.model.id || message.api !== request.model.api) {
      return undefined;
    }
    if (!nonnegativeFiniteNumber(message.usage?.cacheRead) || !nonnegativeFiniteNumber(message.usage?.cacheWrite)) {
      return undefined;
    }
    return {
      entryId: entry.id,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      stopReason: message.stopReason,
    };
  }
  return undefined;
}
