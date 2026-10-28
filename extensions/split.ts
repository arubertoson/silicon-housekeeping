// Workflow inspired by mitsuhiko/agent-stuff/extensions/split-fork.ts at
// 0865c849befd2021490679f96a8dee58c84ac857. Independently maintained tmux integration;
// Pi's SessionManager owns serialization rather than a local JSONL implementation.
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { SPLIT_CHANNEL, type SplitRequest, type SplitResult } from "../support/split.ts";

const usage = 'Usage: /split [fresh|fork] [prompt] | /split session "<session-file>" [prompt]';

function invocation(): string[] {
	const executable = process.execPath;
	if (!/^(node|bun)(\.exe)?$/i.test(basename(executable))) return [executable];
	const script = process.argv[1];
	if (!script || !existsSync(script)) throw new Error("Cannot identify the running Pi entry point.");
	return [executable, script];
}

function parseRequest(args: string): SplitRequest {
	const input = args.trim();
	if (!input) return { kind: "fresh" };
	const mode = /^(fresh|fork)(?:\s+([\s\S]*))?$/.exec(input);
	if (mode) return { kind: mode[1] === "fresh" ? "fresh" : "fork", prompt: mode[2]?.trim() };
	// Only the path is JSON-quoted. The rest is one prompt, not shell syntax.
	const session = /^session\s+("(?:[^"\\]|\\.)*")(?:\s+([\s\S]*))?$/.exec(input);
	if (session) {
		const sessionFile: unknown = JSON.parse(session[1]);
		if (typeof sessionFile === "string" && sessionFile.length > 0) {
			return { kind: "session", sessionFile, prompt: session[2]?.trim() };
		}
	}
	throw new Error(usage);
}

export default function splitExtension(pi: ExtensionAPI): void {
	let generation = 0;
	let active = false;
	let opening = false;
	pi.on("session_start", () => { generation++; active = true; });
	pi.on("session_shutdown", () => { generation++; active = false; });

	async function split(request: SplitRequest, ctx: ExtensionContext): Promise<SplitResult> {
		let locked = false;
		let launchAttempted = false;
		let childFile: string | undefined;
		let ownedForkFile: string | undefined;
		try {
			if (!active) return { status: "refused", message: "The split session is no longer active." };
			if (ctx.mode !== "tui") {
				return { status: "refused", message: "Split requires interactive Pi inside tmux." };
			}
			const pane = process.env.TMUX_PANE;
			if (!process.env.TMUX || !pane || !/^%\d+$/.test(pane)) {
				return { status: "refused", message: "Split requires a tmux pane." };
			}
			if (opening) return { status: "refused", message: "A split launch is already in progress." };

			const epoch = generation;
			const sessionId = ctx.sessionManager.getSessionId();
			const sourceFile = ctx.sessionManager.getSessionFile();
			const leaf = ctx.sessionManager.getLeafId();
			const cwd = ctx.cwd;
			const kind = request.kind;
			const prompt = request.prompt;
			if (kind === "fork" && (!sourceFile || !leaf || !existsSync(sourceFile))) {
				return { status: "refused", message: "No saved conversation to fork yet. Use /split fresh for a fresh Pi session." };
			}
			if (kind === "session") {
				if (!request.sessionFile) throw new Error("A prepared session file is required.");
				const file = resolve(cwd, request.sessionFile);
				const child = statSync(file);
				if (!child.isFile()) throw new Error("The prepared session path is not a file.");
				if (sourceFile && existsSync(sourceFile)) {
					const parent = statSync(sourceFile);
					if (child.dev === parent.dev && child.ino === parent.ino) {
						throw new Error("Cannot open the active parent session as a child. Use /split fork.");
					}
				}
				childFile = file;
			} else if (kind !== "fresh" && kind !== "fork") {
				throw new Error("Unknown split mode.");
			}

			opening = true;
			locked = true;
			const command = invocation();
			const check = await pi.exec("env", ["DEV_WORKSPACE_BACKEND=tmux", "dev-workspace", "pane-can-add", pane], { timeout: 30_000 });
			// Context getters are live. Check generation first: old runtime getters
			// may throw after reload. Never launch work for a replaced session.
			if (epoch !== generation || !active || ctx.sessionManager.getSessionId() !== sessionId) {
				return { status: "refused", message: "The parent session changed before launch.", sessionFile: childFile };
			}
			if (check.code !== 0 || check.killed) {
				return { status: "refused", message: check.stderr.trim() || "Cannot open another tmux pane.", sessionFile: childFile };
			}

			if (kind === "fork") {
				// A separate manager owns serialization; the parent manager is not
				// branched. The captured leaf excludes later parent messages.
				if (!sourceFile || !leaf) throw new Error("The source conversation is unavailable.");
				const snapshot = SessionManager.open(sourceFile, dirname(sourceFile), cwd);
				ownedForkFile = snapshot.createBranchedSession(leaf);
				childFile = ownedForkFile;
				if (!childFile || !existsSync(childFile)) throw new Error("Pi could not persist the forked conversation.");
			}
			if (childFile) command.push("--session", childFile);
			if (prompt) command.push("--", prompt);
			launchAttempted = true;
			const result = await pi.exec("env", [
				"DEV_WORKSPACE_BACKEND=tmux", "dev-workspace", "pane-run", pane, cwd, ...command,
			], { timeout: 30_000 });
			// Exit 2 is refusal before pane creation, including a capacity race.
			// All other failures can have launched Pi. Keep the fork; never retry.
			if (result.code === 2 && !result.killed) {
				launchAttempted = false;
				throw new Error(result.stderr.trim() || "The pane launch was refused.");
			}
			if (result.code !== 0 || result.killed || !/^%\d+$/.test(result.stdout.trim())) {
				throw new Error(result.stderr.trim() || "Could not confirm that the split pane opened.");
			}
			// Return the actual outcome even if ownership changed during launch.
			// UI callers below suppress notices in a replacement parent session.
			return { status: "launched", pane: result.stdout.trim(), sessionFile: childFile };
		} catch (error) {
			let message = error instanceof Error ? error.message : String(error);
			if (!launchAttempted && ownedForkFile) {
				try {
					if (existsSync(ownedForkFile)) unlinkSync(ownedForkFile);
					childFile = undefined;
				} catch (cleanupError) {
					message += ` Fork cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
				}
			}
			return { status: launchAttempted ? "uncertain" : "refused", message, sessionFile: childFile };
		} finally {
			if (locked) opening = false;
		}
	}

	// The bus is Pi's supported inter-extension boundary. Lookup is synchronous;
	// the caller awaits split's promise directly, not an async event handler.
	pi.events.on(SPLIT_CHANNEL, (receive) => {
		if (typeof receive === "function") receive(split);
	});

	async function run(request: SplitRequest, ctx: ExtensionContext): Promise<void> {
		const epoch = generation;
		const sessionId = ctx.sessionManager.getSessionId();
		const result = await split(request, ctx);
		if (epoch !== generation || ctx.sessionManager.getSessionId() !== sessionId || result.status === "launched") return;
		const label = request.kind === "fork" ? "Fork" : "Session";
		const retained = result.sessionFile ? ` ${label} preserved at ${result.sessionFile}` : "";
		const uncertain = result.status === "uncertain" ? " Launch outcome is uncertain. Do not retry automatically." : "";
		ctx.ui.notify(`${result.message}${uncertain}${retained}`, result.status === "uncertain" ? "error" : "warning");
	}

	pi.registerCommand("split", {
		description: `Open Pi in a new tmux pane. ${usage}`,
		handler: async (args, ctx) => {
			let request: SplitRequest;
			try {
				request = parseRequest(args);
			} catch {
				ctx.ui.notify(usage, "warning");
				return;
			}
			await run(request, ctx);
		},
	});
	pi.registerShortcut("alt+shift+o", {
		description: "Fork this conversation into a new tmux pane",
		handler: (ctx) => run({ kind: "fork" }, ctx),
	});
}
