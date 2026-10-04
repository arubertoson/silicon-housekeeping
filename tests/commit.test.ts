import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
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
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const ctx = {
		cwd,
		model: { provider: "test", id: "implementation-model" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { notify: vi.fn() },
	};
	const sendUserMessage = vi.fn((_content: string) => {});
	const api = {
		registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			handler = command.handler;
		},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			events.set(event, handler);
		},
		exec: async (command: string, args: string[], options: { cwd: string }) => run(command, args, options.cwd),
		getThinkingLevel: () => thinking,
		setThinkingLevel: (level: typeof thinking) => { thinking = level; },
		setModel: vi.fn(async (model: typeof ctx.model) => { ctx.model = model; return true; }),
		sendUserMessage,
	};
	commitExtension(api as unknown as ExtensionAPI);
	return {
		sendUserMessage,
		ctx,
		setModel: api.setModel,
		getThinkingLevel: api.getThinkingLevel,
		setThinkingLevel: api.setThinkingLevel,
		emit: async (event: string) => {
			const handler = events.get(event);
			if (!handler) throw new Error(`Missing ${event} handler`);
			await handler({}, ctx as unknown as ExtensionContext);
		},
		notify: ctx.ui.notify,
		invoke: () => handler("", ctx as unknown as ExtensionCommandContext),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("/commit", () => {
	it("selects Git from a subdirectory, keeps the active model, and restores thinking after settling", async () => {
		const root = workspace();
		init("git", ["init", "--quiet", root], root);
		const cwd = join(root, "src");
		mkdirSync(cwd);
		const s = session(cwd);
		const model = s.ctx.model;

		await s.invoke();
		expect(s.sendUserMessage).toHaveBeenCalledOnce();
		expect(s.sendUserMessage.mock.calls[0][0]).toContain("Selected VCS: git.");
		expect(s.getThinkingLevel()).toBe("off");
		expect(s.ctx.model).toBe(model);

		await s.emit("agent_settled");
		expect(s.getThinkingLevel()).toBe("high");
		expect(s.ctx.model).toBe(model);
		expect(s.setModel).not.toHaveBeenCalled();

		s.setThinkingLevel("medium");
		await s.emit("agent_settled");
		expect(s.getThinkingLevel()).toBe("medium");
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

	it("restores thinking on session shutdown", async () => {
		const root = workspace();
		init("git", ["init", "--quiet", root], root);
		const s = session(root);
		await s.invoke();
		expect(s.getThinkingLevel()).toBe("off");
		await s.emit("session_shutdown");
		expect(s.getThinkingLevel()).toBe("high");
		expect(s.setModel).not.toHaveBeenCalled();
	});

	it("does not overwrite a thinking level deliberately changed during the commit", async () => {
		const root = workspace();
		init("git", ["init", "--quiet", root], root);
		const s = session(root);
		await s.invoke();
		s.setThinkingLevel("medium");
		await s.emit("agent_settled");
		expect(s.getThinkingLevel()).toBe("medium");

		await s.invoke();
		expect(s.sendUserMessage).toHaveBeenCalledTimes(2);
		expect(s.getThinkingLevel()).toBe("off");
		await s.emit("agent_settled");
		expect(s.getThinkingLevel()).toBe("medium");
		expect(s.setModel).not.toHaveBeenCalled();
	});

	it("does not overwrite settings for a model deliberately changed during the commit", async () => {
		const root = workspace();
		init("git", ["init", "--quiet", root], root);
		const s = session(root);
		await s.invoke();
		const model = { provider: "other", id: "another-model" };
		s.ctx.model = model;
		await s.emit("agent_settled");
		expect(s.ctx.model).toBe(model);
		expect(s.getThinkingLevel()).toBe("off");

		await s.invoke();
		expect(s.sendUserMessage).toHaveBeenCalledTimes(2);
		await s.emit("agent_settled");
		expect(s.ctx.model).toBe(model);
		expect(s.getThinkingLevel()).toBe("off");
		expect(s.setModel).not.toHaveBeenCalled();
	});

	it("restores thinking if the commit cannot start", async () => {
		const root = workspace();
		init("git", ["init", "--quiet", root], root);
		const s = session(root);
		s.sendUserMessage.mockImplementationOnce(() => { throw new Error("send failed"); });
		await s.invoke();
		expect(s.getThinkingLevel()).toBe("high");
		expect(s.setModel).not.toHaveBeenCalled();
		expect(s.notify).toHaveBeenCalledWith("Cannot start /commit: send failed", "error");
		await s.invoke();
		expect(s.getThinkingLevel()).toBe("off");
		expect(s.sendUserMessage).toHaveBeenCalledTimes(2);
	});
});
