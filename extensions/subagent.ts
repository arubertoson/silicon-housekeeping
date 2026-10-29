/**
 * Subagent extension and in-process AgentSession runner.
 *
 * Deliberately adopted and maintained in Silicon Housekeeping from
 * https://github.com/pasky/pi-amplike
 * Reference commit: 4019ce681df16c65e6dadb82427a0cf16c57a147.
 * Local changes: native Pi 1.4.0 session lifecycle, children reconstructed from
 * the invoking session's tool setup, and removal of Amp permissions, settings
 * and modes.
 *
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { homedir } from "node:os";
import {
	captureSubagentTools,
	selectSubagentTools,
	subagentExtensionSources,
	subagentToolBoundary,
	verifySubagentTools,
	waitForSubagentMcpTools,
	type SubagentToolSetup,
} from "../support/subagent-tools.js";

const SUBAGENT_TOOL = "subagent";
const MAX_CONCURRENCY = 4;
const MINIBOX_LINES = 10;
/** Retained per child; the collapsed view shows only the tail anyway. */
const MAX_DISPLAY_ITEMS = 100;
/**
 * Task preview budget for live views. Briefs can embed long logs; showing them
 * in full makes the continuously redrawn progress view span the screen.
 */
export const TASK_DISPLAY_LINES = 10;
/** Finished expanded views do not redraw continuously, so they show more. */
const TASK_DISPLAY_LINES_EXPANDED = 60;
const BADGE_PART_MAX = 40;

const SUBAGENT_PROMPT = [
	"You are operating as a subagent within a larger agent session.",
	"Follow the task's work mode: investigate/report without changes when requested; make changes only when authorized. This is an instruction, not a filesystem sandbox.",
	"Discover and apply relevant skills yourself. You have no access to the parent's conversation; report missing context rather than inventing it.",
	"Return concise findings with evidence and file locations, changes and verification performed where applicable, and remaining uncertainty. Summarize tool output instead of dumping logs.",
].join("\n");

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

export type SubagentStatus = "running" | "succeeded" | "failed";

export interface SingleResult {
	task: string;
	status: SubagentStatus;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	/** Explicitly requested model, displayed beside the task. */
	agentBadge?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Persisted child session id, for follow-up session queries. */
	sessionId?: string;
	sessionFile?: string;
}

interface SubagentDetails {
	results: SingleResult[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Clamp a task to at most `maxLines` displayed lines, including the omission
 * marker. Trailing blank lines are not reported as omitted content.
 */
export function clampTaskForDisplay(task: string, maxLines = TASK_DISPLAY_LINES): string {
	const lines = task.replace(/\s+$/, "").split("\n");
	if (lines.length <= maxLines) return lines.join("\n");
	const kept = Math.max(1, maxLines - 1);
	return `${lines.slice(0, kept).join("\n")}\n… +${lines.length - kept} more lines`;
}

/** No badge when the child inherits its parent's model. */
export function formatAgentBadge(model?: string): string | undefined {
	const flat = model?.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length > BADGE_PART_MAX ? `${flat.slice(0, BADGE_PART_MAX - 1)}…` : flat;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens > 0) parts.push(`ctx:${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/** Context tokens are per-child and are deliberately not summed. */
function totalUsage(results: readonly SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const { usage } of results) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.turns += usage.turns;
	}
	return total;
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatToolCall(name: string, args: Record<string, unknown>, theme: Theme): string {
	const path = shortenPath(String(args.file_path || args.path || "..."));
	switch (name) {
		case "bash": {
			const command = String(args.command || "...").replaceAll(homedir(), "~").split("\n")[0];
			return theme.fg("muted", "$ ") + theme.fg("toolOutput", command);
		}
		case "read": {
			let text = theme.fg("muted", "read ") + theme.fg("accent", path);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				text += theme.fg("warning", `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`);
			}
			return text;
		}
		case "write": {
			const lines = String(args.content || "").split("\n").length;
			const suffix = lines > 1 ? theme.fg("dim", ` (${lines} lines)`) : "";
			return theme.fg("muted", "write ") + theme.fg("accent", path) + suffix;
		}
		case "edit":
			return theme.fg("muted", "edit ") + theme.fg("accent", path);
		default: {
			const json = JSON.stringify(args);
			return theme.fg("accent", name) + theme.fg("dim", ` ${json.length > 50 ? `${json.slice(0, 50)}...` : json}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusIcon(status: SubagentStatus, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("warning", "⏳");
		case "failed":
			return theme.fg("error", "✗");
		default:
			return theme.fg("success", "✓");
	}
}

function taskLine(r: SingleResult, maxLines: number, theme: Theme): string {
	const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";
	return `${statusIcon(r.status, theme)} ${badge}${theme.fg("dim", clampTaskForDisplay(r.task, maxLines))}`;
}

function toolCallLine(item: Extract<DisplayItem, { type: "toolCall" }>, theme: Theme): string {
	return theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme);
}

/** Live or collapsed view: recent activity only. */
function renderMinibox(r: SingleResult, expanded: boolean, theme: Theme): string {
	const lines = [taskLine(r, TASK_DISPLAY_LINES, theme)];
	if (r.status === "failed" && r.errorMessage) lines.push(theme.fg("error", `Error: ${r.errorMessage}`));

	const items = expanded ? r.displayItems : r.displayItems.slice(-MINIBOX_LINES);
	const skipped = r.displayItems.length - items.length;
	if (skipped > 0) lines.push(theme.fg("muted", `... ${skipped} earlier items`));
	for (const item of items) {
		if (item.type === "toolCall") {
			lines.push(toolCallLine(item, theme));
		} else if (!expanded) {
			const textLines = item.text.split("\n").filter((line) => line.trim());
			lines.push(theme.fg("toolOutput", textLines.slice(0, 5).join("\n")));
			if (textLines.length > 5) lines.push(theme.fg("muted", `... +${textLines.length - 5} lines`));
		}
	}

	const usage = r.status === "running" ? "" : formatUsage(r.usage, r.model);
	if (usage) lines.push(theme.fg("dim", usage));
	return lines.join("\n");
}

/** Finished expanded view: all tool calls and the Markdown answer. */
function addExpandedResult(container: Container, r: SingleResult, theme: Theme, mdTheme: MarkdownTheme): void {
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── ") + taskLine(r, TASK_DISPLAY_LINES_EXPANDED, theme), 0, 0));
	if (r.status === "failed" && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}
	for (const item of r.displayItems) {
		if (item.type === "toolCall") container.addChild(new Text(toolCallLine(item, theme), 0, 0));
	}
	if (r.finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
	}
	const usage = formatUsage(r.usage, r.model);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
}

export function renderResults(results: readonly SingleResult[], expanded: boolean, theme: Theme): Component {
	const running = results.filter((r) => r.status === "running").length;
	const failed = results.filter((r) => r.status === "failed").length;
	const finished = results.length - running;

	let icon = theme.fg("success", "✓");
	let status = results.length === 1 ? "" : `${finished - failed}/${results.length} tasks`;
	if (running > 0) {
		icon = theme.fg("warning", "⏳");
		status = `${finished}/${results.length} done, ${running} running`;
	} else if (failed > 0) {
		icon = theme.fg("warning", "◐");
	}
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(`${SUBAGENT_TOOL} `))}${status ? theme.fg("accent", status) : ""}`;
	const total = running === 0 && results.length > 1 ? formatUsage(totalUsage(results)) : "";
	const totalLine = total ? theme.fg("dim", `Total: ${total}`) : "";

	if (expanded && running === 0) {
		const container = new Container();
		const mdTheme = getMarkdownTheme();
		container.addChild(new Text(header, 0, 0));
		for (const r of results) addExpandedResult(container, r, theme, mdTheme);
		if (totalLine) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(totalLine, 0, 0));
		}
		return container;
	}

	const sections = [header, ...results.map((r) => renderMinibox(r, expanded, theme))];
	if (totalLine) sections.push(totalLine);
	let text = sections.join("\n\n");
	if (!expanded && running === 0) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunSubagentOptions {
	cwd: string;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
	task: string;
	/** Captured invoking-session setup; the only source of child extensions and tools. */
	toolSetup: SubagentToolSetup;
	/** Exact registered names; omitted inherits the captured loadout. */
	tools?: string[];
	agentBadge?: string;
	parentSessionFile?: string;
	signal?: AbortSignal;
	/** Receives an independent snapshot after each observable change. */
	onProgress: (result: SingleResult) => void;
}

function snapshot(result: SingleResult): SingleResult {
	return { ...result, displayItems: result.displayItems.slice(), usage: { ...result.usage } };
}

function assistantText(message: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return message.content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : [])).join("\n");
}

/** A fresh Pi conversation; retries, compaction and settlement belong to Pi. */
export async function runSubagent(options: RunSubagentOptions): Promise<SingleResult> {
	const { cwd, model, task, toolSetup, signal } = options;
	const result: SingleResult = {
		task, status: "running", displayItems: [], finalOutput: "", usage: emptyUsage(),
		model: `${model.provider}/${model.id}`, agentBadge: options.agentBadge,
	};
	if (signal?.aborted) {
		return { ...result, status: "failed", stopReason: "aborted", errorMessage: "aborted before start" };
	}

	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let onAbort: (() => void) | undefined;
	let aborting: Promise<void> | undefined;
	const extensionErrors: string[] = [];
	const fail = (error: unknown) => {
		result.status = "failed";
		result.errorMessage = error instanceof Error ? error.message : String(error);
	};

	try {
		const agentDir = getAgentDir();
		const selected = selectSubagentTools(toolSetup, options.tools);
		const sources = subagentExtensionSources(toolSetup, selected);
		const settingsManager = SettingsManager.inMemory(structuredClone(toolSetup.settings));
		settingsManager.setProjectTrusted(toolSetup.projectTrusted);
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			// Concurrent in-process children must not rediscover parent extensions.
			noExtensions: true,
			additionalExtensionPaths: sources.paths,
			extensionFactories: [...sources.factories, subagentToolBoundary(selected)],
			appendSystemPromptOverride: (base) => [...base, SUBAGENT_PROMPT],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.create(cwd, undefined, { parentSession: options.parentSessionFile });
		const created = await createAgentSession({
			cwd, agentDir, model, thinkingLevel: options.thinkingLevel,
			sessionManager, settingsManager, resourceLoader,
			tools: selected.names, excludeTools: selected.excludeTools,
		});
		const child = created.session;
		session = child;
		result.sessionId = sessionManager.getSessionId();
		result.sessionFile = sessionManager.getSessionFile();
		onAbort = () => {
			// Retain and handle the promise: cancellation must finish before disposal.
			aborting = child.abort().catch(fail);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const syncUsage = () => {
			const usage = emptyUsage();
			for (const entry of sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const u = entry.message.usage;
				usage.input += u.input;
				usage.output += u.output;
				usage.cacheRead += u.cacheRead;
				usage.cacheWrite += u.cacheWrite;
				usage.cost += u.cost.total;
				usage.turns++;
			}
			usage.contextTokens = child.getContextUsage()?.tokens ?? 0;
			result.usage = usage;
		};
		// Only discrete events update progress; streaming deltas would re-sum the
		// session and redraw every child per token.
		unsubscribe = child.subscribe((event) => {
			switch (event.type) {
				case "agent_start":
					// Covers cancellation during asynchronous prompt preflight.
					if (signal?.aborted) onAbort?.();
					return;
				case "message_end":
					if (event.message.role !== "assistant") return;
					result.finalOutput = assistantText(event.message);
					for (const part of event.message.content) {
						if (part.type === "text") result.displayItems.push({ type: "text", text: part.text });
						if (part.type === "toolCall") result.displayItems.push({ type: "toolCall", name: part.name, args: part.arguments });
					}
					syncUsage();
					break;
				case "compaction_start":
					result.displayItems.push({ type: "text", text: `↯ compacting context (${event.reason})…` });
					break;
				case "auto_retry_start":
					result.displayItems.push({ type: "text", text: `↻ retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
					break;
				default:
					return;
			}
			result.displayItems.splice(0, result.displayItems.length - MAX_DISPLAY_ITEMS);
			try {
				options.onProgress(snapshot(result));
			} catch {
				// A host UI callback must not interrupt Pi's event processing.
			}
		});

		if (created.extensionsResult.errors.length) {
			throw new Error(created.extensionsResult.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
		}
		await child.bindExtensions({
			onError: (error) => {
				extensionErrors.push(`${error.extensionPath} (${error.event}): ${error.error}`);
			},
		});
		if (extensionErrors.length) throw new Error(extensionErrors.join("\n"));
		await waitForSubagentMcpTools(child, selected, signal);
		child.setActiveToolsByName(selected.active);
		verifySubagentTools(child, selected);
		if (signal?.aborted) throw new Error("aborted during setup");

		await child.prompt(task, { source: "extension" });
		await child.waitForIdle();

		const last = child.messages.findLast((message) => message.role === "assistant");
		if (last?.role === "assistant") {
			result.finalOutput = assistantText(last);
			result.stopReason = last.stopReason;
			result.errorMessage = last.errorMessage;
			result.model = `${last.provider}/${last.model}`;
		}
		syncUsage();
		result.status = result.stopReason === "error" || result.stopReason === "aborted" ? "failed" : "succeeded";
	} catch (error) {
		fail(error);
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		unsubscribe?.();
		if (session) {
			try {
				await aborting;
				await session.abort();
				// AgentSession.dispose() does not emit extension shutdown, and Pi's
				// emitSessionShutdownEvent helper is not part of the package exports.
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} catch (error) {
				fail(error);
			} finally {
				session.dispose();
			}
		}
		// Extension errors can also arrive while the prompt runs.
		for (const error of extensionErrors) {
			result.status = "failed";
			if (!result.errorMessage?.includes(error)) {
				result.errorMessage = [result.errorMessage, error].filter(Boolean).join("\n");
			}
		}
		if (signal?.aborted) {
			result.status = "failed";
			result.stopReason = "aborted";
			result.errorMessage ??= "aborted";
		}
	}
	return result;
}

/** Run bounded parallel work while preserving task order. */
async function mapWithConcurrency<T, R>(
	items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

const SubagentParams = Type.Object({
	tasks: Type.Array(Type.String(), { minItems: 1, description: "Self-contained briefs: objective; relevant files, errors, commands and observations; work mode (investigate/report only or make changes); expected concise findings, evidence, locations, verification and uncertainty. Children cannot see parent messages." }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Exact registered tool names for every child. Omit to inherit the current session's effective loadout and callable capabilities. Supply only for intentional restrictions; [] disables all tools, including nested calls." })),
	model: Type.Optional(Type.String({ description: "Explicit provider/modelId; otherwise inherit the parent's model and thinking level." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: SUBAGENT_TOOL,
		label: "Subagent",
		description: "Run independent tasks in fresh Pi conversations, up to four at once, inheriting the current session's tool setup unless explicitly restricted. Give each child a self-contained objective, relevant context, work mode and expected concise return. Children share the filesystem, not parent messages. Use for well-defined subtasks benefiting from parallelism or context isolation.",
		promptGuidelines: [
			"Keep parallel tasks independent; sequence work that requires another child's results.",
			"Provide a concrete objective and relevant context: file paths, error messages, commands, observations and prior attempts. Never refer to unseen parent messages such as 'the error above'.",
			"State the work mode explicitly: investigate/report only without changes, or make changes. Tool selection is not a filesystem sandbox.",
			"Request concise findings with supporting evidence and file locations, verification, changes if applicable, and unresolved uncertainty—not raw logs or the full investigation transcript.",
			"Omit tools for the current session's capabilities; specify exact names only for intentional restrictions. Children choose relevant skills themselves.",
		],
		parameters: SubagentParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			let model = ctx.model;
			if (params.model !== undefined) {
				const slash = params.model.indexOf("/");
				model = slash > 0 ? ctx.modelRegistry.find(params.model.slice(0, slash), params.model.slice(slash + 1)) : undefined;
			}
			if (!model) {
				const requested = params.model ? ` for ${JSON.stringify(params.model)} (expected provider/modelId)` : "";
				return { content: [{ type: "text", text: `No model available${requested}.` }], details: { results: [] }, isError: true };
			}
			// Capture once before any sibling starts; no child observes later parent
			// changes. Children never inherit this tool, which bounds in-process fan-out.
			const toolSetup = captureSubagentTools(pi, ctx.isProjectTrusted(), [SUBAGENT_TOOL]);
			const thinkingLevel = pi.getThinkingLevel();
			const parentSessionFile = ctx.sessionManager.getSessionFile();
			const agentBadge = formatAgentBadge(params.model);
			const progress = params.tasks.map((task): SingleResult => ({
				task, status: "running", displayItems: [], finalOutput: "", usage: emptyUsage(), agentBadge,
			}));
			const update = () => {
				const done = progress.filter((r) => r.status !== "running").length;
				onUpdate?.({ content: [{ type: "text", text: `${done}/${progress.length} done` }], details: { results: progress.slice() } });
			};
			update();
			const results = await mapWithConcurrency(params.tasks, MAX_CONCURRENCY, async (task, index) => {
				const result = await runSubagent({
					cwd: ctx.cwd, model, thinkingLevel, task, agentBadge, tools: params.tools, toolSetup,
					parentSessionFile, signal,
					onProgress: (current) => {
						progress[index] = current;
						update();
					},
				});
				progress[index] = result;
				update();
				return result;
			});
			const succeeded = results.filter((r) => r.status === "succeeded").length;
			const summaries = results.map((r) => {
				const output = [r.errorMessage, r.finalOutput].filter(Boolean).join("\n") || "(no output)";
				return `[${r.status === "succeeded" ? "✓" : "✗"}] ${output}${r.sessionFile ? `\n(session file: ${r.sessionFile})` : ""}`;
			});
			return {
				content: [{ type: "text", text: `${succeeded}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
				// Partial failure is not a tool error: sibling results remain usable and
				// per-task status is in the text.
				details: { results }, isError: succeeded === 0,
			};
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details?.results.length) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			return renderResults(details.results, expanded, theme);
		},
	});
}
