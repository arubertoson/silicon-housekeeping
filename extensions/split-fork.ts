// Workflow inspired by mitsuhiko/agent-stuff/extensions/split-fork.ts at
// 0865c849befd2021490679f96a8dee58c84ac857. Independently maintained tmux integration;
// Pi's SessionManager owns serialization rather than a local JSONL implementation.
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";

function invocation(): string[] {
	const executable = process.execPath;
	if (!/^(node|bun)(\.exe)?$/i.test(basename(executable))) return [executable];
	const script = process.argv[1];
	if (!script || !existsSync(script)) throw new Error("Cannot identify the running Pi entry point.");
	return [executable, script];
}

export default function splitForkExtension(pi: ExtensionAPI): void {
	let generation = 0;
	let opening = false;
	pi.on("session_start", () => { generation++; });
	pi.on("session_shutdown", () => { generation++; });

	async function split(prompt: string, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Split-fork requires interactive Pi inside tmux.", "warning");
			return;
		}
		const pane = process.env.TMUX_PANE;
		if (!process.env.TMUX || !pane || !/^%\d+$/.test(pane)) {
			ctx.ui.notify("Split-fork requires a tmux pane.", "warning");
			return;
		}
		if (opening) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const leaf = ctx.sessionManager.getLeafId();
		if (!sessionFile || !leaf || !existsSync(sessionFile)) {
			ctx.ui.notify("No saved conversation to fork yet. Use Alt+O for a fresh Pi session.", "warning");
			return;
		}

		const epoch = generation;
		const sessionId = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd;
		let forkFile: string | undefined;
		opening = true;
		try {
			const command = invocation();
			const check = await pi.exec("env", ["DEV_WORKSPACE_BACKEND=tmux", "dev-workspace", "pane-can-add", pane], { timeout: 30_000 });
			if (epoch !== generation || ctx.sessionManager.getSessionId() !== sessionId) return;
			if (check.code !== 0 || check.killed) {
				ctx.ui.notify(check.stderr.trim() || "Cannot open another tmux pane.", "warning");
				return;
			}

			// Open a separate manager: createBranchedSession changes its owning manager.
			// The captured leaf pins the snapshot even if the parent appends while we check capacity.
			const snapshot = SessionManager.open(sessionFile, dirname(sessionFile), cwd);
			forkFile = snapshot.createBranchedSession(leaf);
			if (!forkFile || !existsSync(forkFile)) throw new Error("Pi could not persist the forked conversation.");

			command.push("--session", forkFile);
			if (prompt) command.push("--", prompt);
			const result = await pi.exec("env", [
				"DEV_WORKSPACE_BACKEND=tmux", "dev-workspace", "pane-run", pane, cwd, ...command,
			], { timeout: 30_000 });
			// Exit 2 is an explicit refusal before pane creation (including a capacity race).
			// Other failures may have launched Pi: retain its session and never retry blindly.
			if (result.code === 2 && !result.killed) {
				unlinkSync(forkFile);
				forkFile = undefined;
			}
			if (epoch !== generation) return;
			if (result.code !== 0 || result.killed || !/^%\d+$/.test(result.stdout.trim())) {
				throw new Error(result.stderr.trim() || "Could not confirm that the fork pane opened.");
			}
		} catch (error) {
			if (epoch !== generation) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`${message}${forkFile ? ` Fork preserved at ${forkFile}` : ""}`, "error");
		} finally {
			opening = false;
		}
	}

	pi.registerCommand("split-fork", {
		description: "Fork this conversation into a new tmux pane. Usage: /split-fork [prompt]",
		handler: (args, ctx) => split(args.trim(), ctx),
	});
	pi.registerShortcut("alt+shift+o", {
		description: "Fork this conversation into a new tmux pane",
		handler: (ctx) => split("", ctx),
	});
}
