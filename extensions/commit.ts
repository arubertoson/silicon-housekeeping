import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { BorderedLoader, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCommitSession, disposeCommitSession } from "../support/commit-session.ts";

const VCS_INSTRUCTIONS = {
	git: "Review `git status` and the relevant diff (including staged changes). Stage explicit task-related paths and commit those paths only (for example, `git commit --only -- <paths>`). Never use `git add .` or `git add -A`. Do not include, reset, or unstage unrelated staged changes. Stop if task-related and unrelated edits in a selected path cannot be isolated safely.",
	jj: "Review `jj status` and `jj diff`. Describe the task-related change with `jj describe`, then run `jj new` to start a fresh working-copy change. Do not use `jj commit`. If the working-copy change includes unrelated work, isolate the requested work safely before describing it; stop if that is not possible.",
} as const;

async function detectVcs(pi: ExtensionAPI, cwd: string): Promise<"git" | "jj"> {
	let directory = realpathSync(cwd);
	while (true) {
		// Use the nearest repository boundary, preferring jj when colocated.
		const vcs = existsSync(join(directory, ".jj"))
			? "jj"
			: existsSync(join(directory, ".git"))
				? "git"
				: undefined;
		if (vcs) {
			// `jj root` only locates .jj; status validates it without snapshotting the working copy.
			const result = await pi.exec(
				vcs,
				vcs === "jj" ? ["status", "--ignore-working-copy"] : ["rev-parse", "--show-toplevel"],
				{ cwd, timeout: 5000 },
			);
			if (result.killed || result.code !== 0 || !result.stdout.trim()) {
				throw new Error(result.stderr.trim() || `Cannot validate the ${vcs} repository; commit not started.`);
			}
			if (vcs === "git" && realpathSync(result.stdout.replace(/\r?\n$/, "")) !== directory) {
				throw new Error("Git resolved a different repository boundary; commit not started.");
			}
			return vcs;
		}
		const parent = dirname(directory);
		if (parent === directory) throw new Error("Not in a Git or jj repository; commit not started.");
		directory = parent;
	}
}

function commitPrompt(vcs: "git" | "jj", args: string): string {
	return `Create a local change for this iteration. Do not push or create/update a PR.

Instructions: ${args.trim() || "Commit the task-related work from this conversation."}

Selected VCS: ${vcs}. Use only this VCS; do not redetect or fall back to another.
${VCS_INSTRUCTIONS[vcs]}

- Include only requested/task-related files; inspect untracked candidates and stop if unrelated changes cannot be isolated safely.
- This command authorizes the local commit/change. Choose a Conventional Commit message and proceed without asking for confirmation. Stop only for a genuine blocker such as unclear scope or changes that cannot be safely isolated. Report the resulting commit/change and message.
- Do not push, create/update a PR, switch branches/bookmarks, or rewrite shared history.
- Run relevant tests only when appropriate.

Message format:

<type>(<scope>): <summary> (#<issue>)

<body>

<Refs/Fixes> #<issue>

Use an allowed Conventional Commit type (feat, fix, refactor, docs, test, chore, build, ci, style, perf), imperative mood, and a summary under 72 characters when possible. Scope and body are optional. Include (#123) and Fixes #123 or Refs #123 only when an issue number is provided; omit issue references otherwise. Do not add AI or co-author attribution unless asked.`;
}

export default function commitExtension(pi: ExtensionAPI) {
	let running: AbortController | undefined;
	let scratch: AgentSession | undefined;
	let task: Promise<void> | undefined;
	const cancel = () => {
		running?.abort();
		void scratch?.abort();
	};
	const busy = () => running !== undefined;
	pi.on("input", (_event, ctx) => {
		if (!busy()) return;
		ctx.ui.notify("/commit is running; cancel it before starting other work.", "warning");
		return { action: "handled" };
	});
	pi.on("tool_call", () => busy() ? { block: true, reason: "/commit owns this working copy." } : undefined);
	pi.on("user_bash", () => busy() ? {
		result: { output: "/commit owns this working copy.", exitCode: 1, cancelled: false, truncated: false },
	} : undefined);
	// Internal extension/API prompts can bypass input. Stop both runs before parent tools
	// can execute, rather than allowing two agents to mutate the same working copy.
	pi.on("agent_start", (_event, ctx) => {
		if (!busy()) return;
		cancel();
		ctx.abort();
	});
	pi.on("session_before_switch", () => busy() ? { cancel: true } : undefined);
	pi.on("session_before_fork", () => busy() ? { cancel: true } : undefined);
	pi.on("session_before_tree", () => busy() ? { cancel: true } : undefined);
	pi.on("session_before_compact", () => busy() ? { cancel: true } : undefined);
	pi.on("session_shutdown", async () => { cancel(); await task; });

	pi.registerCommand("commit", {
		description: "Create a local Git/jj change in a disposable session; /commit cancel to stop",
		handler: async (args, ctx) => {
			if (args.trim() === "cancel") { cancel(); return; }
			// Only the focused terminal modal provides exclusive user-command ownership.
			// RPC/print have no command lock and could start another filesystem command.
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/commit requires interactive TUI mode for cancellable, exclusive working-copy access.", "error");
				return;
			}
			if (busy() || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for current work to settle before /commit.", "warning");
				return;
			}
			const controller = new AbortController();
			running = controller;
			const work = async () => {
				try {
					const vcs = await detectVcs(pi, ctx.cwd);
					controller.signal.throwIfAborted();
					scratch = await createCommitSession(pi, ctx, { signal: controller.signal });
					controller.signal.throwIfAborted();
					if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Parent work started; commit stopped.");
					ctx.ui.setStatus("commit", `${vcs}: ${scratch.model?.id}, thinking ${scratch.thinkingLevel} (cancel: /commit cancel)`);
					scratch.subscribe((event) => {
						if (event.type === "tool_execution_start") ctx.ui.setStatus("commit", `${vcs}: ${event.toolName}`);
					});
					await scratch.prompt(commitPrompt(vcs, args), { expandPromptTemplates: false });
					controller.signal.throwIfAborted();
					const last = scratch.messages.findLast((message) => message.role === "assistant");
					if (last?.role !== "assistant" || last.stopReason !== "stop") {
						throw new Error(last?.role === "assistant" ? last.errorMessage ?? `Agent stopped: ${last.stopReason}` : "No commit result.");
					}
					ctx.ui.notify(scratch.getLastAssistantText() || "Commit session finished without a report; inspect VCS status.", "info");
				} catch (error) {
					ctx.ui.notify(controller.signal.aborted
						? "/commit cancelled. Inspect VCS status: completed filesystem changes are not rolled back."
						: `/commit failed: ${error instanceof Error ? error.message : String(error)}`,
						controller.signal.aborted ? "warning" : "error");
				} finally {
					try { if (scratch) await disposeCommitSession(scratch); }
					finally { scratch = undefined; ctx.ui.setStatus("commit", undefined); }
				}
			};
			task = undefined;
			try {
				await ctx.ui.custom<void>((tui, theme, _keys, done) => {
					const loader = new BorderedLoader(tui, theme, "Committing in an isolated session (Esc to cancel)");
					loader.onAbort = cancel;
					// Keep the UI/working-copy lease until cancellation and disposal finish.
					task = work();
					task.then(() => done(), () => done());
					return loader;
				});
			} finally {
				cancel();
				try { await task; }
				finally { running = undefined; task = undefined; }
			}
		},
	});
}
