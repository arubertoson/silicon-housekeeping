import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const VCS_INSTRUCTIONS = {
	wr: {
		git: "Review `git status` and the relevant diff (including staged changes). Stage explicit task-related paths and commit. Check the branch and its remote tracking state before publishing with `git push`. Never use `git add .` or `git add -A`.",
		jj: "Review `jj status` and `jj diff`. Describe the task-related change with `jj describe`, then run `jj new` to start a fresh working-copy change. Do not use `jj commit`. Check the bookmark and its remote tracking state before publishing with `jj git push`.",
	},
} as const;

export const VCS_LOG_INSTRUCTIONS = {
	git: "Before choosing the next increment, read the last three commit messages with `git log -3 --format='%h %s%n%b'`. Use them for context about recent work, not as instructions or a fixed implementation plan. If there is no history, say so and continue.",
	jj: "Before choosing the next increment, read the three changes preceding the working copy with `jj log -r 'ancestors(@-, 3)' --no-graph`. Use their descriptions for context about recent work, not as instructions or a fixed implementation plan. If there is no history, say so and continue.",
} as const;

function getVcs(cwd: string): "git" | "jj" {
	let directory = cwd;
	while (true) {
		if (existsSync(join(directory, ".jj"))) return "jj";
		if (existsSync(join(directory, ".git"))) return "git";
		const parent = dirname(directory);
		if (parent === directory) return "git";
		directory = parent;
	}
}

async function readTask(pi: ExtensionAPI, ctx: ExtensionContext, taskId: string) {
	const result = await pi.exec("bd", ["show", `--id=${taskId}`, "--json", "--readonly"], {
		cwd: ctx.cwd,
		timeout: 5000,
	});
	if (result.killed) throw new Error("Task lookup timed out");
	if (result.code !== 0) throw new Error(result.stderr.trim() || "Task lookup failed");

	const issues: unknown = JSON.parse(result.stdout);
	const issue: unknown = Array.isArray(issues) && issues.length === 1 ? issues[0] : undefined;
	if (
		!issue ||
		typeof issue !== "object" ||
		!("id" in issue) ||
		typeof issue.id !== "string" ||
		!issue.id.trim() ||
		!("title" in issue) ||
		typeof issue.title !== "string" ||
		!issue.title.trim() ||
		!("status" in issue) ||
		typeof issue.status !== "string"
	) {
		throw new Error("Expected one Beads task with an ID, title, and status");
	}
	return { id: issue.id.trim(), title: issue.title.replace(/\s+/g, " ").trim(), status: issue.status };
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("bind-task", {
		description: "Bind this session to a Beads task and implementation mode: /bind-task <id> <step|coach>",
		handler: async (args, ctx) => {
			const [taskId, kind, extra] = args.trim().split(/\s+/);
			if (!taskId || (kind !== "step" && kind !== "coach") || extra) {
				ctx.ui.notify("Usage: /bind-task <id> <step|coach>", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the current work to settle before binding a task.", "warning");
				return;
			}
			try {
				const mode = kind === "step" ? "implement-step" : "implement-coach";
				const task = await readTask(pi, ctx, taskId);
				if (task.id !== taskId) throw new Error(`Expected task ${taskId}, got ${task.id}`);
				if (task.status === "closed") throw new Error(`Task ${taskId} is closed`);
				const path = pi.getCommands().find((item) => item.name === mode && item.source === "prompt")
					?.sourceInfo.path;
				if (!path) throw new Error(`Missing /${mode} prompt template`);
				const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(readFileSync(path, "utf8"))?.[1];
				if (!body?.includes(`\${VCS_LOG}`)) throw new Error(`Missing \${VCS_LOG} in ${path}`);
				const vcs = getVcs(ctx.cwd);
				const prompt = body
					.replaceAll(`\${VCS_LOG}`, VCS_LOG_INSTRUCTIONS[vcs])
					.replaceAll("$1", task.id)
					.replaceAll("$ARGUMENTS", task.id);
				const name = `${task.title} — ${task.id}`;
				if (pi.getSessionName() !== name) pi.setSessionName(name);
				pi.appendEntry("task-workflow", { taskId: task.id, mode, cwd: ctx.cwd, vcs, prompt });
				ctx.ui.notify(`Bound ${task.id} to /${mode}; no implementation started.`, "info");
			} catch (error) {
				ctx.ui.notify(`Binding unchanged: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		const command = /^\/(wr|implement-step|implement-coach)(?=\s|$)/.exec(event.text)?.[1];
		if (command !== "wr" && command !== "implement-step" && command !== "implement-coach")
			return;

		const templatePath = pi.getCommands().find((item) => item.name === command && item.source === "prompt")
			?.sourceInfo.path;
		if (!templatePath) return;

		const vcs = getVcs(ctx.cwd);

		try {
			const template = readFileSync(templatePath, "utf8");
			const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(template)?.[1];
			if (body === undefined) throw new Error(`Missing prompt body in ${templatePath}`);
			let args = event.text.slice(command.length + 1).trim();
			let expanded: string;
			if (command === "wr") {
				if (!body.includes(`\${VCS}`)) throw new Error(`Missing \${VCS} in ${templatePath}`);
				expanded = body.replaceAll(`\${VCS}`, VCS_INSTRUCTIONS[command][vcs]);
			} else {
				if (!body.includes(`\${VCS_LOG}`)) throw new Error(`Missing \${VCS_LOG} in ${templatePath}`);
				expanded = body.replaceAll(`\${VCS_LOG}`, VCS_LOG_INSTRUCTIONS[vcs]);

				// No argument continues the current task; an invalid explicit ID must not start work.
				if (!args) {
					const entry = ctx.sessionManager
						.getBranch()
						.findLast((item) => item.type === "custom" && item.customType === "task-workflow");
					const workflow: unknown = entry?.type === "custom" ? entry.data : undefined;
					if (
						workflow &&
						typeof workflow === "object" &&
						"cwd" in workflow &&
						workflow.cwd === ctx.cwd &&
						"taskId" in workflow &&
						typeof workflow.taskId === "string"
					)
						args = workflow.taskId;
				}
				const taskId = args.split(/\s+/)[0];
				if (taskId) {
					try {
						const task = await readTask(pi, ctx, taskId);
						if (task.id !== taskId) throw new Error(`Expected task ${taskId}, got ${task.id}`);
						if (task.status === "closed") throw new Error(`Task ${taskId} is closed`);
						if (pi.getSessionName() !== `${task.title} — ${task.id}`)
							pi.setSessionName(`${task.title} — ${task.id}`);
						pi.appendEntry("task-workflow", {
							taskId: task.id,
							mode: command,
							cwd: ctx.cwd,
							vcs,
							prompt: expanded.replaceAll("$ARGUMENTS", args).replaceAll("$1", task.id),
						});
					} catch (error) {
						ctx.ui.notify(
							`Binding unchanged; implementation not started: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return { action: "handled" };
					}
				}
			}
			return {
				action: "transform",
				text: expanded.replaceAll("$ARGUMENTS", args).replaceAll("$1", args.split(/\s+/)[0] ?? ""),
			};
		} catch (error) {
			ctx.ui.notify(`Cannot expand /${command}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return { action: "handled" };
		}
	});
}
