import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import commitExtension from "../extensions/commit.ts";

const roots: string[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", JJ_CONFIG: "/dev/null" };

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "pi-commit-"));
	roots.push(root);
	return root;
}

function run(command: string, args: string[], cwd: string) {
	const result = spawnSync(command, args, { cwd, env, encoding: "utf8" });
	return {
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.error?.message ?? result.stderr ?? "",
		killed: false,
	};
}

function init(command: string, args: string[], cwd: string) {
	const result = run(command, args, cwd);
	if (result.code !== 0) throw new Error(result.stderr);
}

function session(cwd: string) {
	let handler: RegisteredCommand["handler"];
	let thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> = "high";
	const commitModel = { provider: "test", id: "gpt-6-luna" };
	const ctx = {
		cwd,
		model: { provider: "test", id: "implementation-model" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		modelRegistry: { getAvailable: () => [commitModel] },
		ui: { notify: vi.fn() },
	};
	const sendUserMessage = vi.fn((_content: string) => {});
	const api = {
		registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			handler = command.handler;
		},
		on: () => {},
		exec: async (command: string, args: string[], options: { cwd: string }) => run(command, args, options.cwd),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: typeof thinking) => { thinking = level; },
		setModel: async (model: typeof ctx.model) => { ctx.model = model; return true; },
		sendUserMessage,
	};
	commitExtension(api as unknown as ExtensionAPI);
	return {
		sendUserMessage,
		notify: ctx.ui.notify,
		invoke: () => handler("", ctx as unknown as ExtensionCommandContext),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("/commit VCS selection", () => {
	it("selects Git from within a Git repository", async () => {
		const root = workspace();
		init("git", ["init", "--quiet", root], root);
		const cwd = join(root, "src");
		mkdirSync(cwd);
		const s = session(cwd);
		await s.invoke();
		expect(s.sendUserMessage.mock.calls[0][0]).toContain("Selected VCS: git.");
	});

	it("selects jj in a colocated Git/jj repository", async () => {
		const root = workspace();
		init("jj", ["git", "init", "--colocate", root], root);
		const s = session(root);
		await s.invoke();
		expect(s.sendUserMessage.mock.calls[0][0]).toContain("Selected VCS: jj.");
	});

	it("stops outside a repository", async () => {
		const s = session(workspace());
		await s.invoke();
		expect(s.sendUserMessage).not.toHaveBeenCalled();
		expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("Not in a Git or jj repository"), "error");
	});
});
