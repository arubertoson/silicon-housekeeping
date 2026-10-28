/**
 * Subagent extension and in-process AgentSession runner.
 *
 * Deliberately adopted and maintained in Silicon Housekeeping from
 * https://github.com/pasky/pi-amplike
 * Reference commit: 4019ce681df16c65e6dadb82427a0cf16c57a147.
 * Local changes: native Pi 1.4.0 session lifecycle, child-local tool/skill
 * selection, and removal of Amp permissions, settings and modes.
 *
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getMarkdownTheme,
	loadSkills,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ExtensionAPI,
	type Skill,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as os from "node:os";

export const MINIBOX_LINES = 10;
// Max lines of the task/input prompt to show in any rendered view. A /review
// task embeds the entire `git log` inside a ```…``` block, which can be hundreds
// of lines; rendering it in full makes the (live-updating) progress widget span
// the whole screen and flicker badly next to concurrent agent output. The full
// task is always preserved in the session — this only clamps what's displayed.
export const TASK_DISPLAY_LINES = 10;
// Expanded/finished views (transcript) are not live-updating, so
// flicker isn't a concern there; they get a much larger budget so "Ctrl+O to
// expand" still reveals essentially the whole input.
export const TASK_DISPLAY_LINES_EXPANDED = 60;

/**
 * Clamp a task/input prompt to at most `maxLines` TOTAL displayed lines (the
 * "… +N more lines" marker is counted against the budget, so the result never
 * exceeds it). Trailing blank lines are dropped first so they don't get reported
 * as omitted content. Used everywhere the raw task is shown so an oversized
 * input (e.g. a /review commit log) can't blow up the view.
 */
export function clampTaskForDisplay(task: string, maxLines = TASK_DISPLAY_LINES): string {
	const lines = task.replace(/\s+$/, "").split("\n");
	if (lines.length <= maxLines) return lines.join("\n");
	const kept = Math.max(1, maxLines - 1); // reserve one line for the marker
	return `${lines.slice(0, kept).join("\n")}\n… +${lines.length - kept} more lines`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	task: string;
	exitCode: number;
	displayItems: DisplayItem[];
	finalOutput: string;
	usage: UsageStats;
	model?: string;
	/** Explicitly requested model, displayed beside the task. */
	agentBadge?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Subagent session id (persisted) for follow-up session-query. */
	sessionId?: string;
	/** Path to the persisted subagent session file, if any. */
	sessionFile?: string;
}

export interface SubagentDetails {
	results: SingleResult[];
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

/** Hard cap per badge component, so a bogus request can't blow up the header. */
const BADGE_PART_MAX = 40;

function sanitizeBadgePart(s: string): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > BADGE_PART_MAX ? `${flat.slice(0, BADGE_PART_MAX - 1)}…` : flat;
}

/** No badge when the child inherits its parent's model. */
export function formatAgentBadge(model?: string): string | undefined {
	return model?.trim() ? sanitizeBadgePart(model) : undefined;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(u: UsageStats, model?: string): string {
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

export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Path / tool-call formatting
// ---------------------------------------------------------------------------

export function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	fg: Theme["fg"],
): string {
	switch (toolName) {
		case "bash": {
			let cmd = (args.command as string) || "...";
			const home = os.homedir();
			cmd = cmd.replaceAll(home, "~");
			const firstLine = cmd.split("\n")[0];
			return fg("muted", "$ ") + fg("toolOutput", firstLine);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(rawPath));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
}

// ---------------------------------------------------------------------------
// TUI rendering: shared building blocks
// ---------------------------------------------------------------------------

/**
 * Render a single result as a collapsed "minibox" string.
 * Shows icon, optional task preview, error, last N tool calls/text, and usage.
 * Used by the collapsed tool result.
 */
export function renderMinibox(
	r: SingleResult,
	options: { showTask: boolean; expanded: boolean },
	theme: Theme,
): string {
	const isRunning = r.exitCode === -1;
	const isError = r.exitCode > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: isError
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const lines: string[] = [];

	const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";

	if (options.showTask) {
		// Clamp the task to a few lines (see clampTaskForDisplay) so an oversized
		// input can't blow the minibox up to full-screen and flicker.
		lines.push(`${icon} ${badge}${theme.fg("dim", clampTaskForDisplay(r.task))}`);
	} else {
		lines.push(badge ? `${icon} ${badge.trimEnd()}` : icon);
	}

	if (isError && r.errorMessage) {
		lines.push(theme.fg("error", `Error: ${r.errorMessage}`));
	}

	const items = r.displayItems;
	const itemsToShow = options.expanded ? items : items.slice(-MINIBOX_LINES);
	const skipped = items.length - itemsToShow.length;

	if (skipped > 0) {
		lines.push(theme.fg("muted", `... ${skipped} earlier items`));
	}

	for (const item of itemsToShow) {
		if (item.type === "text") {
			if (options.expanded) {
				continue;
			}
			const textLines = item.text.split("\n").filter((l) => l.trim());
			const preview = textLines.slice(0, 5).join("\n");
			lines.push(theme.fg("toolOutput", preview));
			if (textLines.length > 5) lines.push(theme.fg("muted", `... +${textLines.length - 5} lines`));
		} else {
			lines.push(
				theme.fg("muted", "→ ") +
					formatToolCall(item.name, item.args, theme.fg.bind(theme)),
			);
		}
	}

	if (!isRunning) {
		const usageStr = formatUsage(r.usage, r.model);
		if (usageStr) lines.push(theme.fg("dim", usageStr));
	}

	return lines.join("\n");
}

/**
 * Render a single result in expanded form as TUI components added to a container.
 * Shows separator + icon + task + all tool calls + markdown output + usage.
 * Used by the expanded tool result.
 */
export function renderResultExpanded(
	r: SingleResult,
	container: Container,
	theme: Theme,
	mdTheme: MarkdownTheme,
): void {
	const rIcon = r.exitCode === 0
		? theme.fg("success", "✓")
		: r.exitCode === -1
			? theme.fg("warning", "⏳")
			: theme.fg("error", "✗");

	container.addChild(new Spacer(1));
	// Clamp the task prompt (see clampTaskForDisplay) so an oversized input can't
	// dominate the transcript.
	const badge = r.agentBadge ? `${theme.fg("accent", `[${r.agentBadge}]`)} ` : "";
	container.addChild(
		new Text(
			`${theme.fg("muted", "─── ")}${rIcon} ${badge}${theme.fg("dim", clampTaskForDisplay(r.task, TASK_DISPLAY_LINES_EXPANDED))}`,
			0, 0,
		),
	);

	if (r.exitCode > 0 && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	for (const item of r.displayItems) {
		if (item.type === "toolCall") {
			container.addChild(new Text(
				theme.fg("muted", "→ ") +
					formatToolCall(item.name, item.args, theme.fg.bind(theme)),
				0, 0,
			));
		}
	}

	if (r.finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
	}

	const taskUsage = formatUsage(r.usage, r.model);
	if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
}

/**
 * Render a list of results as a complete TUI component.
 * Handles both collapsed and expanded views, single and multi-task.
 * Used by the subagent tool result renderer.
 *
 * @param label - The label to show in the header (e.g. "subagent")
 */
export function renderResults(
	results: SingleResult[],
	options: { expanded: boolean; label: string },
	theme: Theme,
): Component {
	const mdTheme = getMarkdownTheme();

	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const failCount = results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: results.length === 1
			? ""
			: `${successCount}/${results.length} tasks`;

	// --- Expanded view (only when finished) ---
	if (options.expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(
				`${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}${status ? theme.fg("accent", status) : ""}`,
				0, 0,
			),
		);

		for (const r of results) {
			renderResultExpanded(r, container, theme, mdTheme);
		}

		if (results.length > 1) {
			const totalUsage = aggregateUsage(results);
			const totalStr = formatUsage(totalUsage);
			if (totalStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${totalStr}`), 0, 0));
			}
		}

		return container;
	}

	// --- Collapsed / running view ---
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${options.label} `))}${status ? theme.fg("accent", status) : ""}`;
	for (const r of results) {
		text += `\n\n${renderMinibox(r, { showTask: true, expanded: options.expanded }, theme)}`;
	}
	if (!isRunning && results.length > 1) {
		const totalUsage = aggregateUsage(results);
		const totalStr = formatUsage(totalUsage);
		if (totalStr) text += `\n\n${theme.fg("dim", `Total: ${totalStr}`)}`;
	}
	if (!options.expanded && !isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

type ChildSkillsOverride = NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["skillsOverride"]>;

function childSkillSelection(
	cwd: string,
	agentDir: string,
	requestedSkills: string[] | undefined,
): { override: ChildSkillsOverride | undefined; validate: () => void } {
	// Omitted means normal discovery; an explicit empty list means no skills.
	if (requestedSkills === undefined) {
		return { override: undefined, validate: () => {} };
	}

	let configurationError: unknown;
	const selectSkills: ChildSkillsOverride = (discovered) => {
		const selected: Skill[] = [];

		for (const requested of requestedSkills) {
			const isPath = requested.includes("/") || requested.includes("\\") || requested.endsWith(".md") || requested.startsWith("~");
			let matches: Skill[];

			if (isPath) {
				// Pi owns path expansion, Markdown parsing and skill discovery.
				const loaded = loadSkills({ cwd, agentDir, skillPaths: [requested], includeDefaults: false });
				const collision = loaded.diagnostics.find((diagnostic) => diagnostic.type === "collision");
				if (collision) {
					throw new Error(`Ambiguous skill path "${requested}": ${collision.message}`);
				}

				matches = loaded.skills;
			} else {
				const collision = discovered.diagnostics.find((diagnostic) => diagnostic.collision?.name === requested);
				if (collision) {
					throw new Error(`Ambiguous skill "${requested}": ${collision.collision?.winnerPath}, ${collision.collision?.loserPath}. Use an explicit path.`);
				}

				matches = discovered.skills.filter((skill) => skill.name === requested);
			}

			if (matches.length === 0) {
				throw new Error(`Missing skill "${requested}" (child cwd: ${cwd}).`);
			}

			if (matches.length > 1) {
				throw new Error(`Ambiguous skill "${requested}": expected one skill, found ${matches.length}. Use a skill file or root directory.`);
			}

			const skill = matches[0];
			const existing = selected.find((entry) => entry.name === skill.name);
			if (existing && existing.filePath !== skill.filePath) {
				throw new Error(`Ambiguous selected skill "${skill.name}": ${existing.filePath}, ${skill.filePath}.`);
			}

			if (!existing) {
				selected.push(skill);
			}
		}

		return { skills: selected, diagnostics: discovered.diagnostics };
	};

	return {
		override: (discovered) => {
			try {
				const selected = selectSkills(discovered);
				configurationError = undefined;
				return selected;
			} catch (error) {
				// session_start/resources_discover can add skills after reload.
				// Keep the child empty until binding completes, then fail clearly.
				configurationError = error;
				return { skills: [], diagnostics: discovered.diagnostics };
			}
		},
		validate: () => {
			if (configurationError !== undefined) {
				throw configurationError;
			}
		},
	};
}

export interface RunSubagentOptions {
	cwd: string;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
	task: string;
	tools?: string[];
	skills?: string[];
	/** Only explicitly supplied extensions load; concurrent in-process children must not rediscover parent extensions. */
	extensionPaths?: string[];
	agentBadge?: string;
	parentSessionFile?: string;
	signal?: AbortSignal;
	onProgress: (result: SingleResult) => void;
}

/** A fresh Pi conversation; retries, compaction and settlement belong to Pi. */
export async function runSubagent(opts: RunSubagentOptions): Promise<SingleResult> {
	const { cwd, model, task, signal } = opts;
	const result: SingleResult = {
		task, exitCode: -1, displayItems: [], finalOutput: "", usage: emptyUsage(),
		model: `${model.provider}/${model.id}`, agentBadge: opts.agentBadge,
	};
	if (signal?.aborted) {
		return { ...result, exitCode: 1, stopReason: "aborted", errorMessage: "aborted before start" };
	}

	let session: AgentSession | undefined;
	let unsubscribe: (() => void) | undefined;
	let onAbort: (() => void) | undefined;
	let aborting: Promise<void> | undefined;
	const extensionErrors: string[] = [];
	const fail = (error: unknown) => {
		result.exitCode = 1;
		result.errorMessage = error instanceof Error ? error.message : String(error);
	};

	try {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const skillSelection = childSkillSelection(cwd, agentDir, opts.skills);
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			noExtensions: true,
			additionalExtensionPaths: opts.extensionPaths,
			noSkills: opts.skills?.length === 0,
			skillsOverride: skillSelection.override,
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.create(cwd);
		if (opts.parentSessionFile) {
			sessionManager.newSession({ parentSession: opts.parentSessionFile });
		}
		const created = await createAgentSession({
			cwd, agentDir, model, thinkingLevel: opts.thinkingLevel,
			sessionManager, settingsManager, resourceLoader, tools: opts.tools,
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
		unsubscribe = child.subscribe((event) => {
			if (event.type === "agent_start" && signal?.aborted) {
				// Covers cancellation during asynchronous prompt preflight.
				onAbort?.();
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				const message = event.message;
				result.finalOutput = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
				for (const part of message.content) {
					if (part.type === "text") result.displayItems.push({ type: "text", text: part.text });
					if (part.type === "toolCall") result.displayItems.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
			if (event.type === "compaction_start") {
				result.displayItems.push({ type: "text", text: `↯ compacting context (${event.reason})…` });
			}
			if (event.type === "auto_retry_start") {
				result.displayItems.push({ type: "text", text: `↻ retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
			}
			syncUsage();
			try {
				opts.onProgress(result);
			} catch {
				// A host UI callback must not interrupt Pi's event processing.
			}
		});

		if (created.extensionsResult.errors.length) {
			throw new Error(created.extensionsResult.errors.map((error) => `${error.path}: ${error.error}`).join("\n"));
		}
		await child.bindExtensions({
			onError: (error) => { extensionErrors.push(`${error.extensionPath} (${error.event}): ${error.error}`); },
		});
		skillSelection.validate();
		if (opts.tools !== undefined) {
			const available = new Set(child.getAllTools().map((tool) => tool.name));
			const unknown = opts.tools.filter((name) => !available.has(name));
			if (unknown.length) {
				throw new Error(`Unknown child tools: ${unknown.map((name) => JSON.stringify(name)).join(", ")}. Use exact available tool names.`);
			}
			child.setActiveToolsByName(opts.tools);
		}
		if (signal?.aborted) throw new Error("aborted during setup");
		if (extensionErrors.length) throw new Error(extensionErrors.join("\n"));

		await child.prompt([
			"You are operating as a subagent within a larger agent session.",
			"Complete the following task thoroughly, then provide a concise final response as text.",
			"", task,
		].join("\n"), { source: "extension" });
		await child.waitForIdle();

		const last = child.messages.findLast((message) => message.role === "assistant");
		if (last?.role === "assistant") {
			result.finalOutput = last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			result.stopReason = last.stopReason;
			result.errorMessage = last.errorMessage;
			result.model = `${last.provider}/${last.model}`;
		}
		syncUsage();
		result.exitCode = result.stopReason === "error" || result.stopReason === "aborted" ? 1 : 0;
		if (extensionErrors.length) throw new Error(extensionErrors.join("\n"));
	} catch (error) {
		fail(error);
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		unsubscribe?.();
		if (session) {
			try {
				await aborting;
				await session.abort();
				// AgentSession.dispose() does not emit extension shutdown.
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} catch (error) {
				fail(error);
			} finally {
				session.dispose();
			}
		}
		for (const error of extensionErrors) {
			result.exitCode = 1;
			if (!result.errorMessage?.includes(error)) {
				result.errorMessage = [result.errorMessage, error].filter(Boolean).join("\n");
			}
		}
		if (signal?.aborted) {
			result.exitCode = 1;
			result.stopReason = "aborted";
			result.errorMessage ??= "aborted";
		}
	}
	return result;
}

/** Run bounded parallel work while preserving task order. */
export async function mapWithConcurrency<T, R>(
	items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const limit = Math.max(1, Math.min(concurrency, items.length));
	await Promise.all(Array.from({ length: limit }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index], index);
		}
	}));
	return results;
}

const SubagentParams = Type.Object({
	tasks: Type.Array(Type.String(), { minItems: 1, description: "Independent task prompts. Children have no parent conversation: include all required context." }),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Exact tool names for every child. Omit for defaults; [] enables no tools." })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names or paths for every child. Relative paths use the child cwd. Omit for discovery; [] exposes no skills." })),
	model: Type.Optional(Type.String({ description: "Explicit provider/modelId; otherwise inherit the parent's model and thinking level." })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run independent tasks in fresh Pi conversations, up to four at once. Include all needed context and request concise output. Children share the filesystem, not the parent conversation. Use for well-defined subtasks that benefit from parallelism or context isolation.",
		parameters: SubagentParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			let selectedModel = ctx.model;
			if (params.model !== undefined) {
				const slash = params.model.indexOf("/");
				selectedModel = slash > 0
					? ctx.modelRegistry.find(params.model.slice(0, slash), params.model.slice(slash + 1))
					: undefined;
			}
			const model = selectedModel;
			if (!model || params.tasks.length === 0) {
				return {
					content: [{ type: "text", text: !model ? `No model available${params.model ? ` for ${JSON.stringify(params.model)} (expected provider/modelId)` : ""}.` : "Provide at least one task." }],
					details: { results: [] }, isError: true,
				};
			}
			const agentBadge = formatAgentBadge(params.model);
			const progress: SingleResult[] = params.tasks.map((task) => ({
				task, exitCode: -1, displayItems: [], finalOutput: "", usage: emptyUsage(), agentBadge,
			}));
			const update = () => onUpdate?.({
				content: [{ type: "text", text: `${progress.filter((r) => r.exitCode !== -1).length}/${progress.length} done` }],
				details: { results: [...progress] },
			});
			update();
			const results = await mapWithConcurrency(params.tasks, 4, async (task, index) => {
				const result = await runSubagent({
					cwd: ctx.cwd, model, thinkingLevel: pi.getThinkingLevel(), task, agentBadge,
					tools: params.tools, skills: params.skills,
					parentSessionFile: ctx.sessionManager.getSessionFile(), signal,
					onProgress: (result) => { progress[index] = result; update(); },
				});
				progress[index] = result;
				update();
				return result;
			});
			const succeeded = results.filter((r) => r.exitCode === 0).length;
			const summaries = results.map((r) => {
				const output = [r.errorMessage, r.finalOutput].filter(Boolean).join("\n") || "(no output)";
				return `[${r.exitCode === 0 ? "✓" : "✗"}] ${output}${r.sessionFile ? `\n(session file: ${r.sessionFile})` : ""}`;
			});
			return {
				content: [{ type: "text", text: `${succeeded}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
				details: { results }, isError: succeeded === 0,
			};
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details?.results.length) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			return renderResults(details.results, { expanded, label: "subagent" }, theme);
		},
	});
}
