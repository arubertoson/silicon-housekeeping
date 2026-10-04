import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const VCS_INSTRUCTIONS = {
	git: "Review `git status` and the relevant diff (including staged changes). Stage explicit task-related paths and commit. Never use `git add .` or `git add -A`. Do not include unrelated staged changes.",
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
	let starting = false;
	let restore:
		| {
				previousModel: NonNullable<ExtensionContext["model"]>;
				previousThinking: ReturnType<typeof pi.getThinkingLevel>;
		  }
		| undefined;

	function restoreThinking(ctx: ExtensionContext) {
		const saved = restore;
		restore = undefined;
		// Do not overwrite a model or thinking level deliberately changed during the run.
		if (
			!saved ||
			ctx.model?.provider !== saved.previousModel.provider ||
			ctx.model.id !== saved.previousModel.id ||
			pi.getThinkingLevel() !== "off"
		)
			return;
		pi.setThinkingLevel(saved.previousThinking);
		ctx.ui.notify("Restored the previous thinking level after /commit.", "info");
	}

	pi.on("agent_settled", (_event, ctx) => restoreThinking(ctx));
	pi.on("session_shutdown", (_event, ctx) => restoreThinking(ctx));

	pi.registerCommand("commit", {
		description: "Create a local Git or jj change: /commit [issue] [files/instructions]",
		handler: async (args, ctx) => {
			if (starting || restore || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for current work to settle before /commit.", "warning");
				return;
			}
			starting = true;
			try {
				const vcs = await detectVcs(pi, ctx.cwd);
				const previousModel = ctx.model;
				if (!previousModel) throw new Error("Select a model before /commit.");
				const previousThinking = pi.getThinkingLevel();
				// Repository validation can yield; never queue a commit behind newly started work.
				if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for current work before /commit.");
				pi.setThinkingLevel("off");
				restore = { previousModel, previousThinking };
				if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for current work before /commit.");
				ctx.ui.notify(`Commit VCS: ${vcs}; model: ${previousModel.provider}/${previousModel.id}, thinking off.`, "info");
				pi.sendUserMessage(commitPrompt(vcs, args));
			} catch (error) {
				restoreThinking(ctx);
				ctx.ui.notify(`Cannot start /commit: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				starting = false;
			}
		},
	});
}
