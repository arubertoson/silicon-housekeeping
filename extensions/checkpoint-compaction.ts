import { randomUUID } from "node:crypto";
import {
	type CompactionEntryDraft,
	type BoundaryContextPreview,
	convertToLlm,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBoundaryDraft,
	SessionManager,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { RECONCILIATION_INSTRUCTIONS } from "../support/checkpoint.ts";

// Explicit experimental policy in Pi settings; no unvalidated token defaults.
const Policy = Type.Object({
	triggerTokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	rebuiltContextTokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
}, { additionalProperties: false });

type Messages = BoundaryContextPreview["contextMessages"];

function readPolicy(pi: ExtensionAPI): Static<typeof Policy> | undefined {
	const value: unknown = (pi.getSettings() as { checkpointCompaction?: unknown }).checkpointCompaction;
	if (value === undefined) return undefined;
	if (!Check(Policy, value) || value.rebuiltContextTokens >= value.triggerTokens) {
		throw new Error("checkpointCompaction requires positive safe-integer triggerTokens and rebuiltContextTokens, with rebuiltContextTokens below triggerTokens.");
	}
	return value;
}

// An in-memory Pi manager applies proposed entries and replays the prompt/tool
// deltas exactly as Pi does. Never append speculative state to the live branch.
function previewManager(ctx: ExtensionContext, entries: SessionBoundaryDraft[] = []) {
	const header = ctx.sessionManager.getHeader();
	if (!header) throw new Error("Session header is missing.");
	const manager = SessionManager.inMemory(ctx.cwd, undefined, [header, ...ctx.sessionManager.getBranch()]);
	for (const entry of entries) {
		switch (entry.type) {
			case "custom": manager.appendCustomEntry(entry.customType, entry.data); break;
			case "custom_message": manager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details); break;
			case "context_edit": manager.appendContextEdit(entry.targetId, entry.replacement); break;
			case "compaction": manager.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true, entry.usage); break;
		}
	}
	return manager;
}

function conversationTokens(messages: Messages) {
	return convertToLlm(messages).reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)), 0);
}

function systemTokens(messages: Messages) {
	// Replay only system deltas through Pi's public manager. Ordinary boundary
	// checks need no duplicate of the full raw session history.
	const copy = SessionManager.inMemory();
	for (const message of messages) if (message.role === "system") copy.appendMessage(message);
	copy.appendCompaction("", null, 0);
	const entry = copy.getLeafEntry();
	return entry?.type === "compaction" && entry.systemMessage ? estimateTokens(entry.systemMessage) : 0;
}

function summaryTokens(summary: string) {
	return conversationTokens([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }]);
}

function validToolPairs(messages: Messages) {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
		} else if (message.role === "toolResult") {
			if (!calls.has(message.toolCallId)) return false;
			results.add(message.toolCallId);
		}
	}
	return [...calls].every((id) => results.has(id));
}

function retainedBoundary(manager: SessionManager, persistedIds: Set<string>, budget: number, minimum?: string): string | null {
	const entries = manager.buildSessionProjection().entries;
	const start = minimum ? entries.findIndex((entry) => entry.sourceEntry.id === minimum) : 0;
	if (start < 0) throw new Error("Pi's retained boundary is missing from projected context.");
	const suffixTokens = new Array<number>(entries.length + 1).fill(0);
	for (let i = entries.length - 1; i >= start; i--) {
		const messages = entries[i].messages.filter((message) => message.role !== "system" && message.role !== "compactionSummary");
		suffixTokens[i] = suffixTokens[i + 1] + conversationTokens(messages);
	}
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i];
		// Draft IDs are preview-local; only persisted IDs can be committed as a cut.
		if (!persistedIds.has(entry.sourceEntry.id) || entry.sourceEntry.type === "compaction") continue;
		if (entry.messages.some((message) => message.role === "system" || message.role === "toolResult")) continue;
		if (suffixTokens[i] > budget) continue;
		const suffix = entries.slice(i).flatMap((item) => item.messages).filter((message) => message.role !== "system" && message.role !== "compactionSummary");
		if (validToolPairs(suffix)) return entry.sourceEntry.id;
	}
	// Never silently drop another handler's newly proposed model-visible content.
	if (entries.some((entry) => !persistedIds.has(entry.sourceEntry.id) && conversationTokens(entry.messages) > 0)) {
		throw new Error("Proposed boundary messages cannot fit the rebuilt-context budget.");
	}
	return null; // The checkpoint contains the completed batch's consequential state.
}

const Text = Type.String({ minLength: 1, pattern: "\\S" });
const Continuation = Type.Object({
	anchor: Type.Object({
		objective: Text,
		expectedOutcome: Text,
		constraints: Type.Array(Text),
		authority: Text,
	}, { additionalProperties: false }),
	outcomes: Type.Array(Text),
	currentState: Text,
	nextStep: Type.Object({
		kind: Type.Union([
			Type.Literal("implement"), Type.Literal("investigate"), Type.Literal("clarify"),
			Type.Literal("await-approval"), Type.Literal("blocked"), Type.Literal("report-completion"),
		]),
		action: Text,
	}, { additionalProperties: false }),
	uncertainty: Type.Array(Text),
	relevantFiles: Type.Array(Text),
}, { additionalProperties: false });

const SavedContinuation = Type.Object({
	kind: Type.Literal("continuation-compaction"),
	version: Type.Literal(1),
	continuation: Continuation,
});

// Read-only compatibility with the configured external goal extension. No goal creation,
// accounting, status changes, or autonomous continuation is owned here.
const GoalState = Type.Object({
	goal: Type.Union([
		Type.Object({ id: Text, objective: Text, status: Text }),
		Type.Null(),
	]),
});

const COMPACTION_PROMPT = `Extract accepted continuation state for in-place compaction of an ongoing session. Do not continue the conversation or implement anything. You have no tools. Return only JSON matching the schema below.

Compaction may forget the path we took, but must preserve what we are trying to achieve, what we learned that still matters, where we are now, and the immediate next step.

Reconcile accepted state:
${RECONCILIATION_INSTRUCTIONS}

- Establish an objective AND expected outcome even when no long-running goal exists. Do not create a goal. If canonical goal state is supplied, use its objective verbatim; do not maintain a competing objective or infer authority from goal status. Otherwise derive session intent from the conversation.
- Keep the previous anchor stable unless the user explicitly changed direction, outcome, constraints, or authority. Explicit corrections and supersession take precedence. Still-active constraints must not disappear merely because they were not mentioned recently.
- Retain durable outcomes only while relevant: exploration findings, accepted decisions with essential rationale, revised hypotheses and their evidence, consequential rejections, and verification provenance. Preserve outputs of exploration, not its chronology.
- Strongly weight recent evidence for currentState: investigation or debugging, current hypothesis and support, current implementation, pending approvals and genuine blockers. Later retained messages will follow this summary; do not reconstruct their transcript. Use them to reconcile the actual current state and immediate next step, not to invent future work.
- nextStep is mandatory and concrete. It can be implementation, investigation, clarification, awaiting approval, resolving a blocker, or reporting completion. Do not invent unfinished work when the task is complete. Keep explicit pending approvals and genuine blockers even if old. Incidental questions and speculative alternatives may expire if irrelevant to the objective and next action.
- This is NOT a fresh-session handoff. Preserve the established hands-on or autonomous authority, and any actual approval gates. Do not introduce a first-reply summary, a wait gate, or a one-increment limit unless already agreed. Compaction itself grants no new authority or test approval.
- Use provider-visible reasoning only as evidence for rationale, assumptions, and uncertainty, not proof of acceptance. Never depend on hidden reasoning. Truncated outputs and images may leave gaps: disclose consequential uncertainty and use clarification as the next step if needed.
- relevantFiles lists only files needed for the next action, not everything previously touched. Reload selectively; do not instruct the agent to restore all old files or logs. Pi retains the original history; no archive or handoff files are needed.
- Aim for about 500 words total without sacrificing active agreements. customInstructions may focus preservation but may not grant workflow authority or revoke agreements.

JSON schema:
${JSON.stringify(Continuation)}`;

function renderContinuation(state: Static<typeof Continuation>) {
	const bullets = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join("\n") : "None recorded.";
	return `## Session anchor
Objective: ${state.anchor.objective}
Expected outcome: ${state.anchor.expectedOutcome}
Continuation authority: ${state.anchor.authority}

### Active constraints and prohibitions
${bullets(state.anchor.constraints)}

## Relevant durable outcomes
${bullets(state.outcomes)}

## Current working state
${state.currentState}

## Immediate next step (${state.nextStep.kind})
${state.nextStep.action}

## Uncertainty and consequential gaps
${bullets(state.uncertainty)}

## Files relevant to the next action
${bullets(state.relevantFiles)}`;
}

async function extractCheckpoint(
	ctx: ExtensionContext, manager: SessionManager, policy: Static<typeof Policy>, signal: AbortSignal,
	pending: Messages = [], focus = "None", minimum?: string,
): Promise<CompactionEntryDraft> {
	signal.throwIfAborted();
	const model = ctx.model;
	if (!model) throw new Error("Select a model before checkpoint compaction.");
	const leaf = ctx.sessionManager.getLeafId();
	const branchEntries = manager.getBranch();
	const previous = branchEntries.findLast((entry) => entry.type === "compaction");
	const saved = previous?.type === "compaction" && Check(SavedContinuation, previous.details)
		? previous.details.continuation : undefined;
	const goalEntry = branchEntries.findLast((entry) => entry.type === "custom" && entry.customType === "goal");
	if (goalEntry?.type === "custom" && !Check(GoalState, goalEntry.data)) {
		throw new Error("Unsupported goal state; cannot preserve the canonical objective.");
	}
	const persistedGoal = goalEntry?.type === "custom" && Check(GoalState, goalEntry.data) ? goalEntry.data.goal : null;
	const goal = persistedGoal ? { id: persistedGoal.id, objective: persistedGoal.objective, status: persistedGoal.status } : null;
	const overhead = systemTokens(manager.buildSessionContext().messages) + conversationTokens(pending);
	const available = policy.rebuiltContextTokens - overhead;
	const maxTokens = Math.min(Math.floor(available / 2), model.maxTokens > 0 ? model.maxTokens : Infinity);
	if (maxTokens < 256) throw new Error(`Rebuilt-context budget ${policy.rebuiltContextTokens} cannot fit system/tools, pending messages and a checkpoint (overhead: ${overhead} estimated tokens).`);
	const messages = manager.buildSessionContext().messages.filter((message) =>
		message.role !== "system" && !(saved && message.role === "compactionSummary"));
	const conversation = serializeConversation(convertToLlm(messages));
	const response = await ctx.modelRegistry.streamSimple(model, {
		systemPrompt: COMPACTION_PROMPT,
		messages: [{
			role: "user",
			content: `Canonical goal (if present; status is not authorization):\n${JSON.stringify(goal)}\n\nPrevious structured continuation:\n${JSON.stringify(saved ?? null)}\n\nCurrent projected conversation (including the retained recent tail):\n${conversation}\n\nQueued messages not yet in session history (evidence for reconciling the checkpoint only; preserve them as separate queued messages, do not copy or answer them in the checkpoint):\n${pending.length ? serializeConversation(convertToLlm(pending)) : "None"}\n\nCompaction focus:\n${focus}\n\nExtraction output limit: ${maxTokens} tokens. Preserve essential agreements; do not fabricate a smaller contract by silently dropping them.`,
			timestamp: Date.now(),
		}],
	}, {
		signal, maxTokens,
		reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
		cacheRetention: "none", sessionId: randomUUID(),
	}).result();
	signal.throwIfAborted();
	if (response.stopReason !== "stop" || response.content.some((part) => part.type === "toolCall")) {
		throw new Error(response.errorMessage || `Extraction stopped: ${response.stopReason}; checkpoint was not saved.`);
	}
	const draft: unknown = JSON.parse(response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
	if (!Check(Continuation, draft)) throw new Error("Invalid continuation extraction.");
	if (goal) draft.anchor.objective = goal.objective;
	if (ctx.sessionManager.getLeafId() !== leaf) throw new Error("Session changed during extraction; checkpoint was not saved.");
	const summary = renderContinuation(draft);
	const remaining = available - summaryTokens(summary);
	if (remaining < 0) throw new Error("Essential checkpoint cannot fit the rebuilt-context budget; increase rebuiltContextTokens.");
	const boundary = retainedBoundary(manager, new Set(ctx.sessionManager.getBranch().map((entry) => entry.id)), Math.min(4096, remaining), minimum);
	manager.appendCompaction(summary, boundary, 0);
	const rebuilt = manager.buildSessionContext().messages;
	const estimatedTokensAfter = systemTokens(rebuilt) + conversationTokens(rebuilt) + conversationTokens(pending);
	if (estimatedTokensAfter > policy.rebuiltContextTokens) throw new Error("Rebuilt context exceeds its estimated budget; checkpoint was not saved.");
	return {
		type: "compaction", summary, firstKeptEntryId: boundary, usage: response.usage,
		details: { kind: "continuation-compaction", version: 1, continuation: draft, estimatedTokensAfter },
	};
}

export default function checkpointCompactionExtension(pi: ExtensionAPI) {
	let extraction: AbortController | undefined;
	pi.on("session_shutdown", () => extraction?.abort());
	const report = (ctx: ExtensionContext, error: unknown, signal?: AbortSignal) => {
		if (!signal?.aborted) ctx.ui.notify(`Checkpoint compaction stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
	};

	pi.on("turn_end", async (event, ctx) => {
		// Errors/length stops belong to Pi's recovery workflow. Never continue a
		// completed reply just because compacted context ends in a summary message.
		if (event.outcome !== "completed" || event.message.role !== "assistant" ||
			!["stop", "toolUse"].includes(event.message.stopReason) || event.entries.some((entry) => entry.type === "compaction")) return;
		try {
			const policy = readPolicy(pi);
			if (!policy) return;
			if (ctx.model && ctx.model.contextWindow > 0 && policy.triggerTokens >= ctx.model.contextWindow) {
				throw new Error("triggerTokens must be below the selected model's context window; configure a lower threshold for this model.");
			}
			const estimated = systemTokens(event.context.contextMessages) + conversationTokens(event.context.contextMessages);
			// Provider usage is useful until edits/compaction invalidate it. Add newly
			// proposed messages; metadata alone must not hide a threshold crossing.
			const invalidated = event.entries.some((entry) => entry.type === "context_edit");
			const added = event.entries.reduce((sum, entry) => sum + (entry.type === "custom_message"
				? conversationTokens([{ role: "custom", customType: entry.customType, content: entry.content, display: entry.display, timestamp: 0 }]) : 0), 0);
			const tokens = Math.max(estimated, invalidated ? 0 : (ctx.getContextUsage()?.tokens ?? 0) + added) + conversationTokens(event.context.pendingMessages);
			if (tokens < policy.triggerTokens) return;
			extraction = new AbortController();
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, extraction.signal]) : extraction.signal;
			const checkpoint = await extractCheckpoint(ctx, previewManager(ctx, event.entries), policy, signal, event.context.pendingMessages);
			return { entries: [...event.entries, checkpoint] }; // No continuation request.
		} catch (error) {
			report(ctx, error, ctx.signal?.aborted ? ctx.signal : extraction?.signal);
		} finally { extraction = undefined; }
	});

	pi.on("session_before_compact", async (event, ctx) => {
		try {
			const policy = readPolicy(pi);
			if (!policy) return; // No implicit automatic-policy defaults.
			// Own normal triggering, but leave compaction.enabled on: disabling it
			// also disables Pi's overflow/length compact-and-retry recovery.
			if (event.reason === "threshold") return { cancel: true };
			extraction = new AbortController();
			const signal = AbortSignal.any([event.signal, extraction.signal]);
			const checkpoint = await extractCheckpoint(ctx, previewManager(ctx), policy, signal, [], event.customInstructions, event.preparation.firstKeptEntryId);
			if (checkpoint.firstKeptEntryId === null) throw new Error("No tool-safe recent suffix fits this manual/recovery compaction budget; increase rebuiltContextTokens.");
			return { compaction: {
				summary: checkpoint.summary, firstKeptEntryId: checkpoint.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore, details: checkpoint.details, usage: checkpoint.usage,
			} };
		} catch (error) {
			report(ctx, error, event.signal.aborted ? event.signal : extraction?.signal);
			return { cancel: true }; // Never fall through to a lossy default summary.
		} finally { extraction = undefined; }
	});
}
