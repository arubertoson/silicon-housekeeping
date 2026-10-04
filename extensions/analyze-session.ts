import type { ExtensionAPI, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

/** On-demand analysis of existing entries only; never appends session data. */
export default function analyzeSessionExtension(pi: ExtensionAPI): void {
	pi.registerCommand("analyze-session", {
		description: "Estimate per-model compaction cycles from session evidence and diagnose cache economics (read-only)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /analyze-session (active branch; whole-file expenditure shown separately)", "warning");
				return;
			}
			const analysis = analyzeSession(
				ctx.sessionManager.getBranch(), ctx.sessionManager.getEntries(),
			);
			// Current catalog limits are future-facing metadata, not reconstructed historical usage/pricing.
			for (const model of analysis.models) {
				const [provider, id] = JSON.parse(model.configuration) as string[];
				const limit = ctx.modelRegistry?.find(provider, id)?.contextWindow;
				model.contextWindow = nonnegative(limit) && limit > 0 ? limit : undefined;
			}
			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>((tui, theme, _keys, done) => new SessionAnalysisDashboard(analysis, tui, theme, done), {
					overlay: true,
					overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
				});
				return;
			}
			const report = formatSessionAnalysis(analysis);
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else console.log(ctx.mode === "json" ? JSON.stringify({ type: "session_analysis", report }) : report);
		},
	});
}

interface ObservedUsage {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning?: number;
}

export interface Expenditure {
	records: number;
	usable: number;
	prompt: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning: number;
	reasoningRecords: number;
	cost: number;
	costRecords: number;
	zeroCostRecords: number;
}

interface RequestObservation extends ObservedUsage {
	request: number;
	prompt: number;
	successful: boolean;
	/** Present only on consecutive, successful, same-configuration requests without a reset. */
	growth?: number;
	lostReuse?: number;
	repeatedNonRead?: number;
	costs?: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

export interface ModelAnalysis {
	configuration: string;
	calls: number;
	successful: number;
	usableSuccessful: number;
	failed: number;
	aborted: number;
	other: number;
	missingUsage: number;
	inferredThinking: number;
	expenditure: Expenditure;
	prompts: number[];
	growth: number[];
	observations: RequestObservation[];
	contextWindow?: number;
}

export interface CompactionEpoch {
	id: string;
	tokensBefore?: number;
	lastReportedPrompt?: number;
	summary: Expenditure;
	requests: number;
	firstReported?: { prompt: number; request: number; stopReason: string; expenditure: Expenditure };
	subsequent: Expenditure;
	observed: Expenditure;
	endedBy: string;
}

interface TimelinePoint {
	request: number;
	prompt?: number;
	configuration?: string;
	boundary?: string;
}

export interface SessionAnalysis {
	models: ModelAnalysis[];
	branch: Expenditure;
	wholeFile: Expenditure;
	offBranch: Expenditure;
	auxiliary: Array<{ kind: string; expenditure: Expenditure }>;
	compactions: number;
	branchSummaries: number;
	cacheWarmings: number;
	epochs: CompactionEpoch[];
	timeline: TimelinePoint[];
}

function emptyExpenditure(): Expenditure {
	return {
		records: 0, usable: 0, prompt: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0,
		reasoning: 0, reasoningRecords: 0, cost: 0, costRecords: 0, zeroCostRecords: 0,
	};
}

function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** All-zero, partial, or malformed usage is unknown coverage, not free work. */
function usableUsage(value: unknown): ObservedUsage | undefined {
	const usage = object(value);
	if (!usage || !nonnegative(usage.input) || !nonnegative(usage.cacheRead) ||
		!nonnegative(usage.cacheWrite) || !nonnegative(usage.output)) return undefined;
	if (usage.input + usage.cacheRead + usage.cacheWrite + usage.output <= 0) return undefined;
	return {
		input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output,
		reasoning: nonnegative(usage.reasoning) ? usage.reasoning : undefined,
	};
}

function addUsage(total: Expenditure, value: unknown): void {
	total.records++;
	const usage = usableUsage(value);
	if (usage) {
		total.usable++;
		total.prompt += usage.input + usage.cacheRead + usage.cacheWrite;
		total.input += usage.input;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.output += usage.output;
		if (usage.reasoning !== undefined) {
			total.reasoning += usage.reasoning;
			total.reasoningRecords++;
		}
	}
	// Cost coverage is independent of token coverage. Never reconstruct historical prices.
	const cost = object(object(value)?.cost)?.total;
	if (nonnegative(cost)) {
		total.cost += cost;
		total.costRecords++;
		if (cost === 0) total.zeroCostRecords++;
	}
}

function usageRecord(entry: SessionEntry): { kind: string; usage: unknown } | undefined {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") return { kind: "assistant", usage: entry.message.usage };
		if (entry.message.role === "toolResult" && entry.message.usage !== undefined)
			return { kind: "nested tool (unattributed)", usage: entry.message.usage };
	} else if (entry.type === "usage") {
		return { kind: `${entry.kind}: ${entry.provider}/${entry.model} (configuration unknown)`, usage: entry.usage };
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		return { kind: `${entry.type} summary (unattributed)`, usage: entry.usage };
	}
	return undefined;
}

function expenditure(entries: readonly SessionEntry[]): Expenditure {
	const total = emptyExpenditure();
	for (const entry of entries) {
		const record = usageRecord(entry);
		if (record) addUsage(total, record.usage);
	}
	return total;
}

function text(value: unknown): string {
	return typeof value === "string" && value ? value : "unknown";
}

function configurationKey(message: Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }>, thinking: string): string {
	const requested = object(message)?.thinkingLevel;
	return JSON.stringify([
		text(message.provider), text(message.model), text(message.api),
		text(message.responseModel ?? message.model), typeof requested === "string" ? requested : thinking,
		text(message.providerThinkingLevel),
	]);
}

/** Conservative comparison boundaries; ordinary user/tool additions are observed growth. */
function boundary(entry: SessionEntry): string | undefined {
	switch (entry.type) {
		case "compaction": case "branch_summary": case "context_edit":
		case "model_change": case "thinking_level_change": case "custom_message": return entry.type;
		case "message": return entry.message.role === "system" || entry.message.role === "custom"
			? `${entry.message.role} message` : undefined;
		default: return undefined;
	}
}

/** Inputs are raw root-to-leaf history, NOT Pi's compaction-filtered context projection. */
export function analyzeSession(branch: readonly SessionEntry[], all: readonly SessionEntry[]): SessionAnalysis {
	const models = new Map<string, ModelAnalysis>();
	const auxiliary = new Map<string, Expenditure>();
	const epochs: CompactionEpoch[] = [];
	const timeline: TimelinePoint[] = [];
	let requests = 0;
	let thinking = "unknown";
	let previous: { configuration: string; prompt: number; usage: ObservedUsage } | undefined;
	let epoch: CompactionEpoch | undefined;
	let epochConfiguration: string | undefined;
	let compactions = 0;
	let branchSummaries = 0;
	let cacheWarmings = 0;

	for (const entry of branch) {
		const reset = boundary(entry);
		if (reset) {
			timeline.push({ request: requests, boundary: entry.type === "custom_message" && entry.customType === "task-checkpoint" ? "checkpoint (unmeasured)" : reset });
			if (epoch) epoch.endedBy = reset;
			epoch = undefined;
			epochConfiguration = undefined;
			if (entry.type === "compaction") {
				compactions++;
				const summary = emptyExpenditure();
				addUsage(summary, entry.usage);
				epoch = {
					id: entry.id, tokensBefore: nonnegative(entry.tokensBefore) ? entry.tokensBefore : undefined,
					lastReportedPrompt: previous?.prompt, summary, requests: 0,
					subsequent: emptyExpenditure(), observed: emptyExpenditure(), endedBy: "active leaf (open)",
				};
				epochs.push(epoch);
			}
			previous = undefined;
		}
		if (entry.type === "thinking_level_change") thinking = text(entry.thinkingLevel);
		if (entry.type === "branch_summary") branchSummaries++;
		if (entry.type === "usage" && entry.kind === "cache_warm") cacheWarmings++;

		const currentConfiguration = entry.type === "message" && entry.message.role === "assistant"
			? configurationKey(entry.message, thinking) : undefined;
		if (epoch && currentConfiguration) {
			if (epochConfiguration && epochConfiguration !== currentConfiguration) {
				epoch.endedBy = "assistant model/configuration change";
				epoch = undefined;
			} else epochConfiguration = currentConfiguration;
		}

		const record = usageRecord(entry);
		if (record && record.kind !== "assistant") {
			const total = auxiliary.get(record.kind) ?? emptyExpenditure();
			addUsage(total, record.usage);
			auxiliary.set(record.kind, total);
		}
		if (epoch && record && entry.type !== "compaction") {
			addUsage(epoch.observed, record.usage);
			if (epoch.firstReported) addUsage(epoch.subsequent, record.usage);
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		// Newer Pi messages record the request-level thinking setting (including virtual routing).
		const requested = object(message)?.thinkingLevel;
		const configuration = currentConfiguration!;
		let model = models.get(configuration);
		if (!model) {
			model = {
				configuration, calls: 0, successful: 0, usableSuccessful: 0, failed: 0, aborted: 0,
				other: 0, missingUsage: 0, inferredThinking: 0, expenditure: emptyExpenditure(), prompts: [], growth: [], observations: [],
			};
			models.set(configuration, model);
		}
		model.calls++;
		if (typeof requested !== "string" && thinking !== "unknown") model.inferredThinking++;
		const success = ["stop", "length", "toolUse"].includes(message.stopReason);
		if (success) model.successful++;
		else if (message.stopReason === "error") model.failed++;
		else if (message.stopReason === "aborted") model.aborted++;
		else model.other++;
		const usage = usableUsage(message.usage);
		addUsage(model.expenditure, message.usage);
		if (!usage) model.missingUsage++;
		if (success && usage) model.usableSuccessful++;
		const prompt = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
		timeline.push({ request: ++requests, configuration, prompt: prompt > 0 ? prompt : undefined });
		if (usage && prompt > 0) {
			const comparable = success && previous?.configuration === configuration;
			const growth = comparable ? prompt - previous!.prompt : undefined;
			const reported = object(object(message.usage)?.cost);
			// Pair prices with the exact token record. Incomplete/zero/mismatched prices stay unknown.
			const complete = reported && [reported.input, reported.cacheRead, reported.cacheWrite, reported.output, reported.total].every(nonnegative)
				&& (reported.total as number) > 0
				&& (["input", "cacheRead", "cacheWrite", "output"] as const).every((bucket) => usage[bucket] > 0 || reported[bucket] === 0)
				&& Math.abs((reported.input as number) + (reported.cacheRead as number) + (reported.cacheWrite as number) + (reported.output as number) - (reported.total as number)) <= Math.max(1e-8, (reported.total as number) * 0.001);
			model.observations.push({
				...usage, prompt, request: requests, successful: success, growth,
				// Shrinking prompts may prune prefixes; do not classify them as reuse losses.
				lostReuse: growth !== undefined && growth >= 0 ? Math.max(0, previous!.usage.cacheRead - usage.cacheRead) : undefined,
				repeatedNonRead: growth !== undefined && growth >= 0 ? Math.max(0, usage.input + usage.cacheWrite - growth) : undefined,
				costs: complete ? { input: reported.input as number, cacheRead: reported.cacheRead as number,
					cacheWrite: reported.cacheWrite as number, output: reported.output as number } : undefined,
			});
		}
		if (epoch) {
			epoch.requests++;
			if (!epoch.firstReported && prompt > 0) {
				const first = emptyExpenditure();
				addUsage(first, message.usage);
				epoch.firstReported = { prompt, request: epoch.requests, stopReason: message.stopReason, expenditure: first };
			}
		}
		if (success && prompt > 0) {
			model.prompts.push(prompt);
			if (previous?.configuration === configuration) model.growth.push(prompt - previous.prompt);
			previous = { configuration, prompt, usage: usage! };
		} else {
			previous = undefined; // Never bridge an unmeasured, failed, or unfinished request.
		}
	}
	const branchIds = new Set(branch.map((entry) => entry.id));
	return {
		models: [...models.values()], branch: expenditure(branch), wholeFile: expenditure(all),
		offBranch: expenditure(all.filter((entry) => !branchIds.has(entry.id))),
		auxiliary: [...auxiliary].map(([kind, total]) => ({ kind, expenditure: total })),
		compactions, branchSummaries, cacheWarmings, epochs, timeline,
	};
}

const number = (value: number): string => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const measured = (value: number | undefined): string => value === undefined ? "unknown" : number(value);
const clean = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Median uses middle-pair average; p90 uses nearest rank, without interpolation. */
function distribution(values: readonly number[], growth = false): string {
	if (!values.length) return "insufficient evidence (n=0)";
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1];
	return `${growth ? `mean ${number(sorted.reduce((a, b) => a + b, 0) / sorted.length)}, ` : ""}median ${number(median)}, p90 ${number(p90)}${growth ? "" : `, max ${number(sorted[sorted.length - 1])}`} (n=${sorted.length})`;
}

function cost(total: Expenditure): string {
	if (!total.costRecords) return `unknown (0/${total.records} recorded)`;
	return `$${total.cost.toFixed(6)} recorded estimate (${total.costRecords}/${total.records} records; ${total.zeroCostRecords} zero/unverified)`;
}

function tokens(total: Expenditure): string {
	if (!total.usable) return `unknown (${total.records} records; no usable usage)`;
	return `input ${number(total.prompt)} = uncached ${number(total.input)} + cached ${number(total.cacheRead)} + writes ${number(total.cacheWrite)}; output ${number(total.output)}; reasoning ${total.reasoningRecords ? number(total.reasoning) : "unknown"} (${total.reasoningRecords}/${total.usable} reported; included in output)`;
}

function share(total: Expenditure): string {
	return total.prompt > 0 ? `${(100 * total.cacheRead / total.prompt).toFixed(1)}%` : "unknown";
}

export function formatSessionAnalysis(report: SessionAnalysis): string {
	const models = report.models;
	const sum = (key: "calls" | "successful" | "usableSuccessful" | "failed" | "aborted" | "other" | "missingUsage") =>
		models.reduce((total, model) => total + model[key], 0);
	const lines = [
		"Session analysis — active branch, including compacted history",
		...formatDecisionSummary(report), "",
		"Coverage",
		`  Assistant logical calls ${sum("calls")}; successful ${sum("successful")}, successful with usable usage ${sum("usableSuccessful")}.`,
		`  Missing/zero/malformed usage ${sum("missingUsage")}; failed ${sum("failed")}; aborted ${sum("aborted")}; other/unfinished ${sum("other")}.`,
		`  Assistant model/configurations ${models.length}; compactions ${report.compactions}; branch summaries ${report.branchSummaries}; cache-warming records ${report.cacheWarmings}.`,
		"", "Per model/configuration (observed assistant expenditure includes failures/aborts with usage)",
	];
	for (const model of models) {
		const [provider, id, api, response, thinking, providerThinking] = JSON.parse(model.configuration) as string[];
		lines.push(
			`  ${clean(provider)}/${clean(id)} · API ${clean(api)} · response ${clean(response)} · thinking ${clean(thinking)} · provider thinking ${clean(providerThinking)}`,
			`    Calls ${model.calls}; usable successful ${model.usableSuccessful}/${model.successful}; missing usage ${model.missingUsage}; failures ${model.failed}; aborts ${model.aborted}; branch-setting thinking fallback ${model.inferredThinking}.`,
			`    ${tokens(model.expenditure)}`,
			`    Weighted cached-input share ${share(model.expenditure)}; ${cost(model.expenditure)}.`,
			`    Successful reported prompt: ${distribution(model.prompts)}`,
			`    Signed consecutive-request growth proxy: ${distribution(model.growth, true)}`,
		);
	}
	if (!models.length) lines.push("  No assistant records; insufficient evidence.");
	lines.push("", "Auxiliary usage (separate from assistant prompt/growth samples)");
	for (const item of report.auxiliary) lines.push(
		`  ${clean(item.kind)}: ${item.expenditure.usable}/${item.expenditure.records} usable; ${tokens(item.expenditure)}; ${cost(item.expenditure)}.`,
	);
	if (!report.auxiliary.length) lines.push("  None recorded.");
	lines.push("", "Compaction epochs (end at the next context/configuration boundary)");
	for (const epoch of report.epochs) {
		lines.push(
			`  ${clean(epoch.id)} → ${clean(epoch.endedBy)}: ${epoch.requests} logical requests.`,
			`    Before: Pi context estimate ${measured(epoch.tokensBefore)}; last successful reported prompt ${measured(epoch.lastReportedPrompt)} (different measurements).`,
			`    Summarization: ${tokens(epoch.summary)}; ${cost(epoch.summary)}.`,
			`    First subsequent reported prompt: ${epoch.firstReported ? `${number(epoch.firstReported.prompt)} (request ${epoch.firstReported.request}; ${clean(epoch.firstReported.stopReason)})` : "unknown"}.`,
		);
		if (epoch.firstReported) lines.push(
			`    ${epoch.firstReported.request === 1 ? "First measured request, including rebuilding" : "Later measured request (first-request rebuilding unmeasured)"}: ${tokens(epoch.firstReported.expenditure)}; ${cost(epoch.firstReported.expenditure)}.`,
		);
		lines.push(
			`    Later cache reuse: ${epoch.subsequent.usable ? number(epoch.subsequent.cacheRead) : "unknown"} cached tokens, weighted share ${share(epoch.subsequent)} (${epoch.subsequent.usable}/${epoch.subsequent.records} usable records; includes recorded auxiliary usage).`,
			`    Post-boundary observed cost: ${cost(epoch.observed)}; summary plus post-boundary recorded estimate ${epoch.summary.costRecords + epoch.observed.costRecords ? `$${(epoch.summary.cost + epoch.observed.cost).toFixed(6)}` : "unknown"} (incomplete/unverified where coverage is missing or zero).`,
			"    Advisory: insufficient evidence for an optimal threshold or retained-context budget; no checkpoint accounting or controlled representative comparisons.",
		);
	}
	if (!report.epochs.length) lines.push("  No measured compaction outcomes on this branch; insufficient evidence for empirical recommendations. Forecasts above are conditional.");
	lines.push("", "Expenditure scopes (not additive: whole-file includes active branch)");
	for (const [name, total] of [
		["Active branch", report.branch], ["Whole file / all branches", report.wholeFile],
		["Off active branch only", report.offBranch],
	] as const) lines.push(`  ${name}: ${total.usable}/${total.records} usable records; ${tokens(total)}; ${cost(total)}.`);
	lines.push(
		"", "Limits and calculation rules",
		"  Input = uncached + cacheRead + cacheWrite. Reasoning is included in output, never added again.",
		"  Prompt/growth samples use successful positive reported prompts; growth is signed, resets on model/configuration changes, context boundaries, and unmeasured/failed calls. Cache warming is not a prompt/growth sample.",
		"  Median averages the middle pair; p90 is nearest rank. Small sample percentiles are descriptive, not representative evidence.",
		"  Costs are Pi's recorded estimates, NOT actual Codex subscription/credit consumption. Missing/zero usage or pricing does not prove zero expenditure.",
		"  Summary/nested-tool usage lacks model attribution. Unknown thinking is not 'off'; branch-setting fallback may miss historical routing overrides.",
		"  Logical calls do not enumerate provider-internal retries. Unrecorded standalone/checkpoint calls and failed summaries are not recoverable here.",
		"  Snapshot of finalized entries only; no transcript, prompt, settings, compaction, or model-call changes.",
	);
	return lines.join("\n");
}

// Presentation stays local to this extension. No transcript or provider data is copied.
const SECTIONS = ["Policies", "Cache", "History", "Coverage"] as const;

function compact(value: number | undefined): string {
	if (value === undefined) return "unknown";
	const magnitude = Math.abs(value);
	for (const [scale, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) {
		if (magnitude >= scale) return `${(value / scale).toFixed(1).replace(/\.0$/, "")}${suffix}`;
	}
	return number(value);
}

function dollars(value: number): string {
	return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(Math.abs(value) >= 1 ? 3 : 4)}`;
}

function shortCost(total: Expenditure): string {
	if (!total.costRecords) return "unknown";
	const uncertain = total.costRecords < total.records || total.zeroCostRecords > 0;
	return `${dollars(total.cost)}${uncertain ? "*" : ""}`;
}

function stats(values: readonly number[]): { median?: number; mean?: number; p90?: number; max?: number } {
	if (!values.length) return {};
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return {
		median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
		mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		p90: sorted[Math.ceil(sorted.length * 0.9) - 1], max: sorted[sorted.length - 1],
	};
}

function modelLabel(model: ModelAnalysis): string {
	const [provider, id, , , thinking] = JSON.parse(model.configuration) as string[];
	return clean(`${provider}/${id} · ${thinking}`);
}

function pad(value: string, width: number, right = false): string {
	const fitted = truncateToWidth(value, width);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	return right ? padding + fitted : fitted + padding;
}

interface CacheDiagnostics {
	pricedInputRecords: number;
	pricedPrompt: number;
	pricedNonRead: number;
	outputCost: number;
	pricedOutputRecords: number;
	inputCost: number;
	uncachedCost: number;
	readCost: number;
	writeCost: number;
	withReads: number;
	shares: number[];
	comparisons: number;
	drops: number;
	lostReuse: number;
	repeatedNonRead: number;
	rates: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
}

/** Costs and tokens must be paired; total session cost is not an input unit price. */
function cacheDiagnostics(model: ModelAnalysis): CacheDiagnostics {
	const result: CacheDiagnostics = {
		pricedInputRecords: 0, pricedPrompt: 0, pricedNonRead: 0, outputCost: 0, pricedOutputRecords: 0,
		inputCost: 0, uncachedCost: 0, readCost: 0, writeCost: 0,
		withReads: 0, shares: [], comparisons: 0, drops: 0, lostReuse: 0, repeatedNonRead: 0, rates: {},
	};
	for (const bucket of ["input", "cacheRead", "cacheWrite", "output"] as const) {
		let tokens = 0, cost = 0;
		for (const record of model.observations) {
			if (record[bucket] > 0 && record.costs && record.costs[bucket] > 0) {
				tokens += record[bucket]; cost += record.costs[bucket];
			}
		}
		if (tokens > 0) result.rates[bucket] = cost / tokens;
	}
	for (const record of model.observations) {
		result.shares.push(100 * record.cacheRead / record.prompt);
		if (record.cacheRead > 0) result.withReads++;
		if (record.costs && (["input", "cacheRead", "cacheWrite"] as const).every((bucket) =>
			record[bucket] === 0 || record.costs![bucket] > 0)) {
			result.pricedInputRecords++;
			result.pricedPrompt += record.prompt;
			result.pricedNonRead += record.input + record.cacheWrite;
			result.uncachedCost += record.costs.input;
			result.readCost += record.costs.cacheRead;
			result.writeCost += record.costs.cacheWrite;
		}
		if (record.costs && (record.output === 0 || record.costs.output > 0)) {
			result.outputCost += record.costs.output;
			result.pricedOutputRecords++;
		}
		if (record.lostReuse !== undefined) {
			result.comparisons++;
			result.lostReuse += record.lostReuse;
			result.repeatedNonRead += record.repeatedNonRead!;
			if (record.lostReuse >= 1024) result.drops++;
		}
	}
	result.inputCost = result.uncachedCost + result.readCost + result.writeCost;
	return result;
}

interface CyclePolicy {
	trigger: number;
	restart: number;
	calls: number;
	costWarm: number;
	costCold: number;
	summaryWarm: number;
	summaryCold: number;
	rebuildExtra: number;
	ceilingCostWarm?: number;
	ceilingCostCold?: number;
}

interface PolicyEstimate {
	growth?: number;
	growthMedian?: number;
	growthP90?: number;
	growthSamples: number;
	steadySamples: number;
	pricedRecords: number;
	nonRead?: number;
	observedReuse?: number;
	ceiling: number;
	headroom: number;
	gridStep: number;
	assumedWindow: boolean;
	missing?: string;
	policies: CyclePolicy[];
}

/** Repeating reset → growth → reset cycles. The current/last prompt is deliberately not an input. */
function estimatePolicy(model: ModelAnalysis, summaryTokens: number, headroom: number, restarts: readonly number[]): PolicyEstimate {
	const growth = stats(model.growth);
	const diagnostics = cacheDiagnostics(model);
	// Exclude initial requests after every context/config/measurement boundary from steady-state calibration.
	const steady = model.observations.filter((record) => record.successful && record.growth !== undefined);
	const reserved = Math.max(headroom, summaryTokens, stats(model.observations.filter((record) => record.successful).map((record) => record.output)).p90 ?? 0);
	const ceiling = Math.max(0, (model.contextWindow ?? 256_000) - reserved);
	const gridStep = Math.max(1000, Math.ceil(ceiling / 4096 / 1000) * 1000);
	const estimate: PolicyEstimate = {
		growth: growth.mean, growthMedian: growth.median, growthP90: growth.p90,
		growthSamples: model.growth.length, steadySamples: steady.length, pricedRecords: diagnostics.pricedInputRecords,
		ceiling, headroom: reserved, gridStep, assumedWindow: model.contextWindow === undefined,
		policies: [],
	};
	if (model.growth.length < 3) { estimate.missing = "Need at least three comparable growth samples to estimate a repeating cycle."; return estimate; }
	if (growth.mean === undefined || growth.mean <= 0) { estimate.missing = "Average context growth is not positive; no finite size-driven compaction cycle can be inferred."; return estimate; }
	const prompt = steady.reduce((sum, record) => sum + record.prompt, 0);
	const reads = steady.reduce((sum, record) => sum + record.cacheRead, 0);
	const writes = steady.reduce((sum, record) => sum + record.cacheWrite, 0);
	const uncached = steady.reduce((sum, record) => sum + record.input, 0);
	estimate.observedReuse = prompt > 0 ? reads / prompt : undefined;
	const nonRead = (uncached + writes) / steady.length;
	estimate.nonRead = nonRead;
	const { input, cacheRead, cacheWrite, output } = diagnostics.rates;
	if (input === undefined || output === undefined || (reads > 0 && cacheRead === undefined) || (writes > 0 && cacheWrite === undefined)) {
		estimate.missing = "Missing positive recorded prices for uncached input, output, or observed cache use.";
		return estimate;
	}
	const nonReadRate = uncached + writes > 0 ? (uncached * input + writes * (cacheWrite ?? input)) / (uncached + writes) : input;
	const readRate = reads > 0 ? cacheRead! : nonReadRate; // Never infer caching for a configuration that reported none in steady state.
	const coldRate = Math.max(input, cacheWrite ?? input);
	const ordinaryOutput = steady.reduce((sum, record) => sum + record.output, 0) / steady.length * output;
	// Predict a fixed amount of new/non-read work per call, NOT a fixed cache percentage at every context size.
	const inputCost = (size: number) => Math.min(size, nonRead) * nonReadRate + Math.max(0, size - nonRead) * readRate;
	const integralInputCost = (size: number) => {
		const base = Math.min(size, nonRead), cached = Math.max(0, size - nonRead);
		return nonReadRate * base * base / 2 + nonReadRate * nonRead * cached + readRate * cached * cached / 2;
	};
	for (const restart of restarts) {
		let best: CyclePolicy | undefined;
		let atCeiling: CyclePolicy | undefined;
		const first = Math.ceil((restart + Math.max(gridStep, growth.mean)) / gridStep) * gridStep;
		const candidates: number[] = [];
		for (let trigger = first; trigger <= estimate.ceiling; trigger += gridStep) candidates.push(trigger);
		if (estimate.ceiling >= first && candidates.at(-1) !== estimate.ceiling) candidates.push(estimate.ceiling);
		for (const trigger of candidates) {
			const calls = (trigger - restart) / growth.mean;
			const ordinaryInput = (integralInputCost(trigger) - integralInputCost(restart)) / (trigger - restart);
			const summaryWarm = inputCost(trigger) + summaryTokens * output;
			const summaryCold = trigger * coldRate + summaryTokens * output;
			// Average ordinary input already includes the first post-reset call at normal reuse. Charge only its excess once.
			const rebuildExtra = restart * coldRate - inputCost(restart);
			const policy: CyclePolicy = {
				trigger, restart, calls, summaryWarm, summaryCold, rebuildExtra,
				costWarm: ordinaryInput + ordinaryOutput + summaryWarm / calls,
				costCold: ordinaryInput + ordinaryOutput + (summaryCold + rebuildExtra) / calls,
			};
			// Conservative choice BETWEEN THESE TWO SCENARIOS, not a bound on real provider behavior.
			if (!best || Math.max(policy.costWarm, policy.costCold) < Math.max(best.costWarm, best.costCold)) best = policy;
			if (trigger === estimate.ceiling) atCeiling = policy;
		}
		if (best) {
			best.ceilingCostWarm = atCeiling?.costWarm;
			best.ceilingCostCold = atCeiling?.costCold;
			estimate.policies.push(best);
		}
	}
	if (!estimate.policies.length) estimate.missing = "No restart budget leaves room for a growth cycle under the assumed trigger ceiling.";
	return estimate;
}

function formatDecisionSummary(report: SessionAnalysis): string[] {
	const lines = ["Per-model repeating-cycle policies — one active-branch session supplies the evidence; not an action for its current context"];
	for (const model of report.models) {
		const estimate = estimatePolicy(model, 2000, 16_000, [64_000]);
		const policy = estimate.policies[0];
		lines.push(`  ${modelLabel(model)}: mean growth ${compact(estimate.growth)} tokens/model call (n=${estimate.growthSamples}); cached ${share(model.expenditure)}.`);
		if (policy) lines.push(`    Test compacting near ${compact(policy.trigger)} and restarting near ${compact(policy.restart)} total prompt tokens; ~${number(policy.calls)} calls/cycle.`,
			`    Estimated recurring cost/model call ${dollars(policy.costWarm)} / ${dollars(policy.costCold)} (warm / cold reset scenarios).`);
		else lines.push(`    No numeric policy candidate: ${estimate.missing}`);
		lines.push(`    Trigger ceiling ${compact(estimate.ceiling)} (${estimate.assumedWindow ? "assumed 256k window" : "current catalog window"}, minus ${compact(estimate.headroom)} headroom; max of 16k assumption, summary size, and observed p90 output).`);
	}
	lines.push("  Same-model 2k total summary output per reset (including reasoning); mean signed growth; fixed non-read work/call and historical rates.",
		"  Warm resets reuse normally; cold summaries/rebuilds use the higher weighted input/write price. Each reset is charged once.",
		"  Targets are total prompt sizes, NOT keepRecentTokens. Safe restart size and quality/recall effects are unmeasured.",
		"  Candidates minimize the larger of two forecast costs on a bounded token grid, not measured performance or a universal optimum.");
	return lines;
}

function effectivePrice(diagnostics: CacheDiagnostics): string {
	return diagnostics.pricedPrompt > 0 ? `${dollars(diagnostics.inputCost / diagnostics.pricedPrompt * 1e6)}/M input` : "unknown input price";
}

function parseRestartTarget(value: string): number | undefined {
	const match = /^((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s*([km])?$/i.exec(value.trim());
	if (!match) return undefined;
	const places = match[2]?.toLowerCase() === "m" ? 6 : match[2] ? 3 : 0;
	const [whole, fraction = ""] = match[1].replaceAll(",", "").split(".");
	if (/[1-9]/.test(fraction.slice(places))) return undefined;
	// Shift decimal digits before conversion so values like 1.001k are exactly 1,001 tokens.
	const tokens = Number(whole + fraction.slice(0, places).padEnd(places, "0"));
	return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

/** Bounded, paged screen: header/summary remain visible while the body scrolls. */
export class SessionAnalysisDashboard implements Component, Focusable {
	private section = 0;
	private selected = 0;
	private detail = false;
	private offset = 0;
	private pageSize = 1;
	private bodyLength = 0;
	private revealSelection = false;
	private headroom = 16_000;
	private retained = 64_000;
	private summaryTokens = 2_000;
	private targetInput?: Input;
	private targetError?: string;
	private hasFocus = false;

	private cached?: { width: number; height: number; lines: string[] };
	private readonly calls: number;
	private readonly usable: number;

	constructor(
		private readonly report: SessionAnalysis,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: () => void,
	) {
		this.calls = report.models.reduce((sum, model) => sum + model.calls, 0);
		this.usable = report.models.reduce((sum, model) => sum + model.expenditure.usable, 0);
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) {
		this.hasFocus = value;
		if (this.targetInput) this.targetInput.focused = value;
		this.invalidate();
	}

	invalidate(): void {
		this.cached = undefined;
		this.targetInput?.invalidate();
	}

	handleInput(input: string): void {
		if (this.targetInput) {
			if (matchesKey(input, Key.ctrl("c"))) this.targetInput = undefined;
			else {
				const previous = this.targetInput.getValue();
				this.targetInput.handleInput(input);
				if (this.targetInput && this.targetInput.getValue() !== previous) this.targetError = undefined;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(input, Key.ctrl("c")) || matchesKey(input, "q")) { this.done(); return; }
		if (matchesKey(input, Key.escape)) {
			if (!this.detail) { this.done(); return; }
			this.revealSelection = true;
			this.detail = false;
			this.offset = 0;
		} else if (matchesKey(input, Key.left) || matchesKey(input, Key.shift("tab")) ||
			matchesKey(input, Key.right) || matchesKey(input, Key.tab)) {
			const direction = matchesKey(input, Key.left) || matchesKey(input, Key.shift("tab")) ? -1 : 1;
			const previousSection = this.section;
			this.section = (this.section + SECTIONS.length + direction) % SECTIONS.length;
			if (this.section >= 2 || previousSection >= 2) this.selected = 0;
			this.detail = false;
			this.offset = 0;
		} else if (!this.detail && this.section === 0 && matchesKey(input, "r")) {
			this.editRestartTarget();
		} else if (!this.detail && this.section === 0 && (matchesKey(input, "h") || matchesKey(input, "s"))) {
			const headroom = matchesKey(input, "h");
			const options = headroom ? [8_000, 16_000, 32_000, 64_000] : [1000, 2000, 4000, 8000, 16_000, 32_000];
			const current = headroom ? this.headroom : this.summaryTokens;
			const next = options[(options.indexOf(current) + 1) % options.length];
			if (headroom) this.headroom = next;
			else this.summaryTokens = next;
			this.offset = 0;
		} else if (matchesKey(input, Key.enter) && !this.detail && this.selectableCount() > 0) {
			this.detail = true;
			this.offset = 0;
		} else if (matchesKey(input, Key.up) || matchesKey(input, Key.down)) {
			const direction = matchesKey(input, Key.up) ? -1 : 1;
			if (!this.detail && this.selectableCount() > 0) {
				this.selected = Math.max(0, Math.min(this.selectableCount() - 1, this.selected + direction));
				this.revealSelection = true;
			} else this.offset += direction;
		} else if (matchesKey(input, Key.pageUp) || matchesKey(input, Key.pageDown)) {
			this.offset += matchesKey(input, Key.pageUp) ? -this.pageSize : this.pageSize;
		} else if (matchesKey(input, Key.home)) this.offset = 0;
		else if (matchesKey(input, Key.end)) this.offset = this.bodyLength;
		else return;
		this.invalidate();
		this.tui.requestRender();
	}

	private editRestartTarget(): void {
		const field = new Input({ placeholder: number(this.retained), placeholderStyle: (text) => this.theme.fg("muted", text) });
		field.focused = this.focused;
		this.targetError = undefined;
		field.onEscape = () => { this.targetInput = undefined; };
		field.onSubmit = (value) => {
			if (!value.trim()) { this.targetInput = undefined; return; }
			const target = parseRestartTarget(value);
			if (target === undefined) {
				this.targetError = "Enter a positive whole token count, e.g. 48k, 48.5k, or 64,000.";
				return;
			}
			const model = this.report.models[this.selected];
			const estimate = model ? estimatePolicy(model, this.summaryTokens, this.headroom, [target]) : undefined;
			if (estimate && Math.ceil((target + Math.max(estimate.gridStep, estimate.growth ?? 0)) / estimate.gridStep) * estimate.gridStep > estimate.ceiling) {
				this.targetError = `Restart must leave room for a growth cycle below the ${number(estimate.ceiling)}-token ceiling. Lower the target or adjust headroom.`;
				return;
			}
			this.retained = target;
			this.targetInput = undefined;
			this.offset = 0;
		};
		this.targetInput = field;
	}

	private renderTargetInput(width: number, height: number): string[] {
		const field = this.targetInput!.render(width);
		if (height < 3) return field.slice(0, height).map((line) => truncateToWidth(line, width));
		const lines = [
			this.heading("Restart target · TOTAL post-reset prompt tokens"), ...field,
			...wrapTextWithAnsi(this.theme.fg("muted", `Type a new target; blank keeps ${number(this.retained)} tokens.`), width),
			...(this.targetError ? wrapTextWithAnsi(this.warning(this.targetError), width) : []), "",
			...wrapTextWithAnsi("Includes system/tools, continuation prompts, and the checkpoint. This sets the analysis assumption only.", width),
			...wrapTextWithAnsi(this.theme.fg("muted", "Examples: 48k · 48.5k · 64,000 · 100000. Checkpoint behavior is not changed yet."), width),
		].slice(0, height - 1);
		while (lines.length < height - 1) lines.push("");
		lines.push(this.theme.fg("muted", "Esc cancel · Enter apply · Ctrl+U clear"));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private selectableCount(): number {
		return this.section === 0 || this.section === 1 ? this.report.models.length
			: this.section === 2 ? this.report.epochs.length : 0;
	}

	private heading(label: string): string { return this.theme.fg("accent", label); }
	private warning(label: string): string { return this.theme.fg("warning", label); }

	private timeline(width: number): string[] {
		const points = this.report.timeline;
		const prompts = points.flatMap((point) => point.prompt === undefined ? [] : [point.prompt]);
		if (!prompts.length) return ["Timeline unavailable: no positive reported prompts."];
		const maximum = prompts.reduce((max, prompt) => Math.max(max, prompt), 0);
		const columns = Math.max(1, Math.min(points.length, width - 10));
		const buckets = Array.from({ length: columns }, () => [] as TimelinePoint[]);
		points.forEach((point, index) => buckets[Math.min(columns - 1, Math.floor(index * columns / points.length))].push(point));
		const palette = ["accent", "success", "warning", "muted"] as const;
		const lines = [this.heading(`Reported prompt timeline · max ${compact(maximum)}`)];
		for (let row = 4; row >= 0; row--) {
			let plot = "";
			for (const bucket of buckets) {
				const measured = bucket.filter((point) => point.prompt !== undefined);
				const point = measured.reduce<TimelinePoint | undefined>((best, next) => !best || next.prompt! > best.prompt! ? next : best, undefined);
				if (!point || Math.round(point.prompt! / maximum * 4) !== row) { plot += " "; continue; }
				const index = this.report.models.findIndex((model) => model.configuration === point.configuration);
				plot += this.theme.fg(palette[Math.max(0, index) % palette.length], "●");
			}
			lines.push(`${pad(compact(maximum * row / 4), 7, true)} │${plot}`);
		}
		let markers = "";
		for (const bucket of buckets) {
			const boundaries = bucket.filter((point) => point.boundary);
			const mark = boundaries.some((point) => point.boundary === "compaction") ? "C"
				: boundaries.some((point) => point.boundary!.startsWith("checkpoint")) ? "H"
				: boundaries.some((point) => point.boundary === "branch_summary") ? "B"
				: boundaries.length ? "|" : bucket.some((point) => point.configuration && point.prompt === undefined) ? "?" : " ";
			markers += this.theme.fg(mark === "?" ? "warning" : "muted", mark);
		}
		lines.push(`        ${markers}`, this.theme.fg("muted", "Branch event order →  C compact · H checkpoint · B branch · | context/config · ? unknown"));
		lines.push(this.report.models.map((model, index) => this.theme.fg(palette[index % palette.length], `● ${modelLabel(model)}`)).join("  "));
		if (points.length > columns) lines.push(this.theme.fg("muted", "Compressed: each column shows the largest measured prompt; boundaries may overlap."));
		return lines;
	}

	private selectionRows(): string[] {
		return this.report.models.map((model, index) => {
			const name = `${index === this.selected ? "›" : " "} ${modelLabel(model)}`;
			return (index === this.selected ? this.heading(name) : name) + `  |  growth ${compact(stats(model.growth).mean)}/call  |  cached ${share(model.expenditure)}  |  ${effectivePrice(cacheDiagnostics(model))}`;
		});
	}

	private overview(_width: number): string[] {
		const model = this.report.models[this.selected];
		if (!model) return ["No assistant measurements; cannot estimate a model policy."];
		const restarts = [...new Set([32_000, 64_000, 96_000, 128_000, this.retained])].sort((a, b) => a - b);
		const estimate = estimatePolicy(model, this.summaryTokens, this.headroom, restarts);
		const chosen = estimate.policies.find((policy) => policy.restart === this.retained);
		const lines = [...this.selectionRows(), "", this.heading("PER-MODEL POLICY · provisional, not a decision for the current context")];
		lines.push(`Your restart target: ${number(this.retained)} total prompt tokens (assumed) · r to edit.`);
		if (chosen) lines.push(
			this.heading(`Test compacting around ${compact(chosen.trigger)} → restarting around ${compact(chosen.restart)} tokens.`),
			`Trigger = context size BEFORE reset. Restart = TOTAL prompt size AFTER reset.`,
			`Expected cycle: ~${Math.round(chosen.calls)} model calls, growing by ${compact(estimate.growth)} tokens/call.`,
			`Estimated recurring cost/call: ${dollars(chosen.costWarm)} warm / ${dollars(chosen.costCold)} cold (summary + rebuilding included).`);
		else lines.push(this.warning("No policy for the selected restart assumption: " + (estimate.missing ?? "no room under the trigger ceiling.")));
		if (chosen?.ceilingCostWarm !== undefined && chosen.ceilingCostCold !== undefined) lines.push(
			`Forecast cost/call change vs waiting until ${compact(estimate.ceiling)}: ${(100 * (chosen.costWarm / chosen.ceilingCostWarm - 1)).toFixed(1)}% warm / ${(100 * (chosen.costCold / chosen.ceilingCostCold - 1)).toFixed(1)}% cold.`);
		if (estimate.policies.length) {
			lines.push("", this.heading("COMPACTION TRIGGER → RESTART · CYCLE · COST/CALL (WARM / COLD)"));
			for (const policy of estimate.policies) lines.push(
				`${policy.restart === this.retained ? "*" : " "} ${pad(compact(policy.trigger), 6)} trigger → ${pad(compact(policy.restart), 6)} restart  |  ~${pad(String(Math.round(policy.calls)), 3, true)} calls/cycle  |  ${dollars(policy.costWarm)} / ${dollars(policy.costCold)} per call`);
		}
		lines.push("", this.heading("MEASUREMENTS BEHIND THIS MODEL PROFILE"),
			`Context growth: mean ${compact(estimate.growth)} · median ${compact(estimate.growthMedian)} · p90 ${compact(estimate.growthP90)} tokens/call (n=${estimate.growthSamples}).`,
			`Steady non-read work: ${compact(estimate.nonRead)} tokens/call · measured cache reuse ${estimate.observedReuse === undefined ? "unknown" : (100 * estimate.observedReuse).toFixed(1) + "%"} (n=${estimate.steadySamples}).`,
			`Evidence: ONE active-branch session · ${estimate.pricedRecords}/${model.observations.length} paired input prices. Other workloads may differ.`,
			"", this.warning(`Restart ${compact(this.retained)} is an assumption, NOT a validated safe budget. Recall/task quality are unmeasured.`),
			`Sizing: ${compact(model.contextWindow ?? 256_000)} ${estimate.assumedWindow ? "ASSUMED" : "catalog"} window − ${compact(estimate.headroom)} headroom → ${compact(estimate.ceiling)} maximum trigger.`,
			this.theme.fg("muted", `Assumed: same-model ${compact(this.summaryTokens)} summary output (reasoning included); linear-growth cycles; fixed non-read work/call.`),
			this.theme.fg("muted", "Warm resets reuse normally. Cold summaries/rebuilds have no reads, priced at the higher weighted input/write rate."),
			this.theme.fg("muted", `Triggers minimize the larger forecast cost on a ${compact(estimate.gridStep)} grid. Not measured optima or real cost bounds.`),
			"r edit restart target · s summary size · h headroom · Cache tab for spending / reuse diagnostics");
		return lines;
	}

	private cacheView(): string[] {
		const model = this.report.models[this.selected];
		if (!model) return ["No assistant usage recorded."];
		const diagnostics = cacheDiagnostics(model);
		const total = model.expenditure;
		const priced = diagnostics.pricedInputRecords > 0;
		const proportions = (value: number) => diagnostics.inputCost > 0 ? `${dollars(value)} (${(100 * value / diagnostics.inputCost).toFixed(1)}%)` : "unknown";
		const rate = (value: number | undefined) => value === undefined ? "unknown" : `${dollars(value * 1e6)}/M`;
		const medianShare = stats(diagnostics.shares).median;
		const sortedShares = [...diagnostics.shares].sort((a, b) => a - b);
		const p10 = sortedShares.length ? sortedShares[Math.max(0, Math.ceil(sortedShares.length * 0.1) - 1)] : undefined;
		return [...this.selectionRows(), "", this.heading("CACHE HEALTH · actual measured input, not provider-internal cache hit probability"),
			`Token-weighted reuse ${share(total)} · median request reuse ${medianShare === undefined ? "unknown" : medianShare.toFixed(1) + "%"} · p10 ${p10 === undefined ? "unknown" : p10.toFixed(1) + "%"}`,
			`Requests with any cached read ${diagnostics.withReads}/${model.observations.length} · input token coverage ${total.usable}/${total.records}`,
			`Read ${compact(total.cacheRead)} · uncached ${compact(total.input)} · write ${compact(total.cacheWrite)} input tokens`,
			"", this.heading("INPUT COST · exact price/token pairs only; output excluded"),
			`Effective ${effectivePrice(diagnostics)} · paired input pricing ${diagnostics.pricedInputRecords}/${model.observations.length} records`,
			`Input charges ${priced ? dollars(diagnostics.inputCost) : "unknown"}: uncached ${proportions(diagnostics.uncachedCost)} · reads ${proportions(diagnostics.readCost)} · writes ${proportions(diagnostics.writeCost)}`,
			`Recorded bucket rates: uncached ${rate(diagnostics.rates.input)} · cache read ${rate(diagnostics.rates.cacheRead)} · write ${rate(diagnostics.rates.cacheWrite)}`,
			`Cache-read discount vs uncached: ${diagnostics.rates.input !== undefined && diagnostics.rates.cacheRead !== undefined ? (100 * (1 - diagnostics.rates.cacheRead / diagnostics.rates.input)).toFixed(1) + "%" : "unknown"}`,
			`Output charges ${diagnostics.pricedOutputRecords ? dollars(diagnostics.outputCost) : "unknown"} (${diagnostics.pricedOutputRecords}/${model.observations.length} paired records) · recorded output rate ${rate(diagnostics.rates.output)}`,
			"", this.heading("CHECK FOR REBILLING · proxies on comparable, nonshrinking requests"),
			diagnostics.comparisons ? `${diagnostics.drops ? "Inspect reuse drops" : "No ≥1k reuse drops detected"}: ${diagnostics.drops}/${diagnostics.comparisons} comparisons · previously read tokens lost ${compact(diagnostics.lostReuse)}` : "Insufficient comparable requests for reuse-drop checks.",
			`Repeated non-read input beyond net prompt growth: ${diagnostics.comparisons ? compact(diagnostics.repeatedNonRead) : "unknown"} tokens (proxy, NOT proven waste)`,
			"Lost reuse = positive decrease in cacheRead; repeated non-read = input + writes minus positive prompt growth.",
			"A drop can reflect prefix changes, expiry, eligibility, or legitimate new work. Inspect it; do not label it avoidable cost.",
			"First requests after context/config changes and requests after failures/missing usage are excluded; shrinking prompts are excluded.",
			"", this.heading("CONTEXT GROWTH / COVERAGE"),
			`Prompt ${distribution(model.prompts)} · mean ${compact(stats(model.prompts).mean)}`,
			`Signed growth ${distribution(model.growth, true)}`,
			`Failed ${model.failed} · aborted ${model.aborted} · unknown usage ${model.missingUsage} · total recorded cost ${shortCost(total)}`,
			"Enter for exact configuration, output/reasoning, and price coverage."];
	}

	private modelDetails(model: ModelAnalysis): string[] {
		const [provider, id, api, response, thinking, providerThinking] = JSON.parse(model.configuration) as string[];
		const total = model.expenditure;
		const count = (value: number) => total.usable ? number(value) : "unknown";
		return [
			this.heading(modelLabel(model)), `Provider ${clean(provider)} · model ${clean(id)}`,
			`API ${clean(api)} · response model ${clean(response)}`,
			`Thinking ${clean(thinking)} · provider thinking ${clean(providerThinking)} · branch-setting fallback ${model.inferredThinking}`,
			"", this.heading("Prompt / growth measurements"),
			`Reported successful prompts: ${distribution(model.prompts)}`,
			`Mean prompt: ${measured(stats(model.prompts).mean)}`,
			`Signed growth proxy: ${distribution(model.growth, true)}`,
			"Growth comparisons exclude context/configuration boundaries and failed/unmeasured requests.",
			"", this.heading("Assistant expenditure · includes recorded failed/aborted calls"),
			`Total input ${count(total.prompt)} · uncached ${count(total.input)} · cached ${count(total.cacheRead)} · writes ${count(total.cacheWrite)}`,
			`Output ${count(total.output)} · reported reasoning ${total.reasoningRecords ? number(total.reasoning) : "unknown"} (${total.reasoningRecords}/${total.usable} records; already included in output)`,
			`Weighted cached-input share ${share(total)} · NOT a cache-hit/miss percentage`,
			`Cost: ${cost(total)}`,
			`Mean recorded cost/record: ${total.costRecords ? dollars(total.cost / total.costRecords) : "unknown"} (measured costs only; zeros unverified)`,
			"", this.heading("Coverage"),
			`Calls ${model.calls} · successful with usable usage ${model.usableSuccessful}/${model.successful}`,
			`Missing/zero/malformed usage ${model.missingUsage} · failures ${model.failed} · aborts ${model.aborted} · other ${model.other}`,
			"Cache tab shows measured costs and comparable-request reuse-loss / repeated-input proxies, not proven waste.",
		];
	}

	private epochDetails(epoch: CompactionEpoch): string[] {
		const first = epoch.firstReported;
		return [
			this.heading(`Compaction ${clean(epoch.id)}`), `Interval ends at ${clean(epoch.endedBy)} · ${epoch.requests} logical requests`,
			`Before: Pi context estimate ${measured(epoch.tokensBefore)} · last reported successful prompt ${measured(epoch.lastReportedPrompt)}`,
			"These are different measurements, not directly interchangeable.",
			"", this.heading("Upfront summarization · model unattributed"), tokens(epoch.summary), cost(epoch.summary),
			"", this.heading("First subsequent measured request"),
			first ? `Reported prompt ${number(first.prompt)} · request ${first.request} · ${clean(first.stopReason)}` : "No post-compaction prompt recorded.",
			...(first ? [tokens(first.expenditure), cost(first.expenditure)] : []),
			...(!first || first.request !== 1 ? [this.warning("First-request rebuilding is unmeasured.")] : ["Includes observed input/cache writes; rebuilding overhead is not isolated."]),
			"", this.heading("Subsequent usage / estimated expenditure"),
			`Later cached input ${epoch.subsequent.usable ? number(epoch.subsequent.cacheRead) : "unknown"} · weighted share ${share(epoch.subsequent)}`,
			`Observed post-boundary cost: ${cost(epoch.observed)}`,
			`Summary + observed cost: ${epoch.summary.costRecords + epoch.observed.costRecords ? dollars(epoch.summary.cost + epoch.observed.cost) : "unknown"} (coverage above; not proof of complete expenditure)`,
			"", this.warning("Break-even: insufficient evidence."),
			"Missing: checkpoint expenditure, a defensible without-compaction baseline, and representative comparisons.",
			"No optimal threshold or retained-context budget can be inferred here.",
		];
	}

	private coverage(): string[] {
		const sum = (key: "failed" | "aborted" | "missingUsage" | "other") => this.report.models.reduce((total, model) => total + model[key], 0);
		const lines = [this.heading("Coverage / expenditure scopes"),
			`Assistant usage ${this.usable}/${this.calls} usable · missing ${sum("missingUsage")} · failed ${sum("failed")} · aborted ${sum("aborted")} · other ${sum("other")}`];
		for (const [name, total] of [["Active branch", this.report.branch], ["Whole file (includes active branch)", this.report.wholeFile], ["Off active branch only", this.report.offBranch]] as const) {
			if (name === "Off active branch only" && !total.records) lines.push("No off-branch expenditure records; whole-file totals match the active branch.");
			else lines.push("", this.heading(name), `${total.usable}/${total.records} usable usage records`, tokens(total), cost(total));
		}
		lines.push("", this.heading("Auxiliary work · excluded from assistant prompt/growth samples"));
		for (const auxiliary of this.report.auxiliary) lines.push(clean(auxiliary.kind), tokens(auxiliary.expenditure), cost(auxiliary.expenditure), "");
		if (!this.report.auxiliary.length) lines.push("None recorded.");
		lines.push("", this.heading("Calculation rules / limitations"),
			"Input = uncached + cacheRead + cacheWrite. Reasoning is included in output, never added twice.",
			"Median averages the middle pair; p90 is nearest rank. Small samples are descriptive, not representative evidence.",
			"Growth is a signed difference between comparable reported requests, not just assistant output added each turn.",
			"Missing/zero usage or pricing does not prove zero expenditure. * marks incomplete or zero/unverified cost.",
			"Unknown thinking is not 'off'; historical branch-setting fallback may miss routing overrides.",
			"Logical calls do not enumerate provider-internal retries. Unrecorded standalone/checkpoint calls are not recoverable.",
			"Checkpoint markers do not imply checkpoint cost coverage; parent/child session analysis is not implemented.",
			"Reuse-loss events use a ≥1,024-token drop in cacheRead across nonshrinking comparable prompts; token identities are not known.",
			"Forecast prices use positive recorded bucket price/token pairs. Missing/zero bucket prices stay unknown.",
			"Policies model repeating restart → linear growth → compaction cycles, using mean signed growth across comparable calls.",
			"Steady-state input cost assumes fixed typical non-read tokens per call; remaining prompt input is cached only if that configuration reported reuse.",
			"Average input cost integrates that curve over each cycle; same-model summarization and rebuilding are amortized across (trigger − restart)/growth calls.",
			"Warm/cold reset scenarios use historical bucket rates, not measured reset costs. Ordinary output cost is held at its observed steady-call mean.",
			"Cycles use a continuous-growth approximation; displayed call counts are rounded. Short cycles or lumpy growth need empirical validation.",
			"Policy ranking minimizes the larger of those two scenario costs for EACH assumed restart budget. It does not find a safe restart budget.",
			"Trigger ceiling is catalog window (or explicitly assumed 256k) minus max(assumed headroom, summary output, observed p90 output); not a capacity guarantee.",
			"Cycle costs cover this model's assistant calls plus an assumed reset; extra tool-service/cache-warming costs are not forecast. They remain in the ledger.",
			"Cycle costs assume successful work calls; future retries/failures and task-quality differences are not forecast. Recorded failure spending stays in the ledger.",
			"One active-branch session supplies this initial model profile; cross-session/workload aggregation is not implemented. A turn here is an assistant model call.",
			"Warm/cold summarization and first-request rebuilding are scenarios, NOT measured bounds. Rebuilding is charged exactly once.",
			"Post-compaction prompt targets include everything (system + summary + retained content); they are NOT Pi keepRecentTokens settings.",
			"No additional model calls, transcript entries, prompt changes, or automatic compaction/settings tuning.");
		return lines;
	}

	private body(width: number): string[] {
		if (this.detail && this.section < 2) return this.modelDetails(this.report.models[this.selected]);
		if (this.detail && this.section === 2) return this.epochDetails(this.report.epochs[this.selected]);
		if (this.section === 0) return this.overview(width);
		if (this.section === 1) return this.cacheView();
		if (this.section === 2) {
			if (!this.report.epochs.length) return [...this.timeline(width), "", this.heading("Measured compaction / handover economics"),
				"No compaction epochs on this branch.", this.warning("Payback: insufficient evidence."),
				"Custom checkpoint handovers require extraction usage and linked parent/child sessions; not available yet."];
			return [...this.timeline(width), "", this.heading("Compaction intervals · select for boundary measurements"), ...this.report.epochs.flatMap((epoch, index) => {
				const label = `${index === this.selected ? "›" : " "} ${clean(epoch.id)} · ${epoch.requests} requests · ends ${clean(epoch.endedBy)}`;
				return [index === this.selected ? this.heading(label) : label,
					`  Before ${measured(epoch.tokensBefore)} (Pi estimate) → ${measured(epoch.firstReported?.prompt)} (reported)`,
					`  Summary ${shortCost(epoch.summary)} · post-boundary ${shortCost(epoch.observed)} · payback unknown`];
			}), "", this.warning("Historical payback is unmeasured; Policies shows recurring-cycle forecasts, not measured savings.")];
		}
		return this.coverage();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows || 24);
		if (this.cached?.width === width && this.cached.height === height) return this.cached.lines;
		const contentWidth = Math.max(1, Math.min(120, width));
		if (this.targetInput) return this.renderTargetInput(contentWidth, height);
		const tabs = SECTIONS.map((section, index) => index === this.section ? this.heading(`[${section}]`) : this.theme.fg("muted", section)).join("  ");
		const chrome = [this.heading("Model compaction policies") + "  " + tabs,
			`Evidence: 1 active-branch session + compacted history · ${this.calls} model calls · ${this.usable}/${this.calls} usable`,
			this.theme.fg("muted", "Cost estimates use recorded API prices, NOT actual Codex credits. No automatic tuning."), ""];
		let help = contentWidth < 80 ? "q close · Tab view · ↑↓ row · Enter open · PgDn page"
			: this.detail ? "Esc back · q close · ↑↓ scroll · PgUp/PgDn page" : "q close · Tab view · ↑↓ model · Enter details · PgDn page" + (this.section === 0 ? " · r edit target · s summary · h headroom" : "");
		if (height < 7) return [chrome[0], this.warning("Enlarge terminal · Esc/q close")].slice(0, height).map((line) => truncateToWidth(line, contentWidth));
		const body = this.body(contentWidth).flatMap((line) => line ? wrapTextWithAnsi(line, contentWidth) : [""]);
		this.pageSize = Math.max(1, height - chrome.length - 2);
		this.bodyLength = body.length;
		this.offset = Math.max(0, Math.min(Math.max(0, body.length - this.pageSize), this.offset));
		// Keep a selected list row visible; details have independent scrolling.
		if (this.revealSelection && !this.detail && this.selectableCount()) {
			const selectedLabel = this.section < 2 ? modelLabel(this.report.models[this.selected]) : clean(this.report.epochs[this.selected].id);
			const first = body.findIndex((line) => line.includes("›") && line.includes(truncateToWidth(selectedLabel, 16, "")));
			if (first >= 0 && first < this.offset) this.offset = first;
			else if (first >= this.offset + this.pageSize) this.offset = Math.max(0, first - this.pageSize + 1);
		}
		this.revealSelection = false;
		help += ` · ${Math.min(body.length, this.offset + 1)}–${Math.min(body.length, this.offset + this.pageSize)}/${body.length}`;
		const visibleBody = body.slice(this.offset, this.offset + this.pageSize);
		while (visibleBody.length < this.pageSize) visibleBody.push("");
		const lines = [...chrome, ...visibleBody, "", this.theme.fg("muted", help)]
			.map((line) => truncateToWidth(line, contentWidth));
		this.cached = { width, height, lines };
		return lines;
	}
}

