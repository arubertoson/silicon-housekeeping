import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	initTheme,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import checkpointExtension from "../extensions/checkpoint.ts";

const roots: string[] = [];

beforeAll(() => initTheme("dark"));

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkpointSession(pause: boolean, status = "open") {
	const cwd = mkdtempSync(join(tmpdir(), "pi-checkpoint-"));
	roots.push(cwd);
	const original = SessionManager.create(cwd, cwd);
	original.appendMessage({ role: "user", content: "Continue the agreed work.", timestamp: Date.now() });
	original.appendCustomEntry("task-workflow", {
		taskId: "bd-task",
		mode: "implement-step",
		cwd,
		vcs: "git",
		prompt: "Implement one agreed increment.",
	});
	const issue = { id: "bd-task", title: "Example task", status, notes: "Keep existing notes unchanged." };
	const draft = {
		checkpoint: "### Goal\nFinish the agreed caller.\n\n### Immediate next action\nReview the caller's shape.",
		pause,
		reason: pause ? "Awaiting shape review." : "Next increment is agreed.",
		tests: "deferred",
		testScope: "No tests are authorized.",
	};
	let handler: RegisteredCommand["handler"];
	let replacement: SessionManager | undefined;
	const notify = vi.fn();
	const sendUserMessage = vi.fn(async (content: string) => {
		replacement!.appendMessage({ role: "user", content, timestamp: Date.now() });
	});
	const exec = vi.fn(async (command: string, args: string[]) => {
		if (command === "bd") {
			if (args[0] !== "show" || !args.includes("--readonly")) throw new Error("Beads must remain read-only");
			return { code: 0, killed: false, stdout: JSON.stringify([issue]), stderr: "" };
		}
		if (command === "git" && args[0] === "status") {
			return { code: 0, killed: false, stdout: "## main\n", stderr: "" };
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	});
	const api = {
		on: () => {},
		registerCommand: (_name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			handler = command.handler;
		},
		getCommands: () => [{
			name: "implement-step",
			source: "prompt",
			sourceInfo: { path: fileURLToPath(new URL("../commands/implement-step.md", import.meta.url)) },
		}],
		exec,
	};
	const ctx = {
		cwd,
		mode: "tui",
		model: { contextWindow: 100_000 },
		thinkingLevel: "off",
		sessionManager: original,
		isIdle: () => true,
		hasPendingMessages: () => false,
		modelRegistry: {
			streamSimple: () => ({
				result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(draft) }] }),
			}),
		},
		ui: {
			notify,
			custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => { dispose(): void }) => {
				let component: { dispose(): void } | undefined;
				try {
					return await new Promise((resolve) => {
						component = factory({ requestRender: () => {} }, { fg: (_color: string, text: string) => text }, {}, resolve);
					});
				} finally {
					component?.dispose();
				}
			},
		},
		newSession: async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
			replacement = SessionManager.create(cwd, cwd);
			replacement.newSession({ parentSession: options?.parentSession });
			await options?.setup?.(replacement);
			await options?.withSession?.({
				sendUserMessage,
				ui: { notify, setEditorText: vi.fn() },
			} as unknown as ExtensionCommandContext & { sendUserMessage: typeof sendUserMessage });
			return { cancelled: false };
		},
	};
	checkpointExtension(api as unknown as ExtensionAPI);
	return {
		invoke: (steering = "") => handler(steering, ctx as unknown as ExtensionCommandContext),
		original,
		issue,
		replacement: () => replacement,
		sendUserMessage,
		notify,
	};
}

describe("/checkpoint session handoff", () => {
	it.each([false, true])("persists the checkpoint and summary kickoff without updating Beads (pause=%s)", async (pause) => {
		const s = checkpointSession(pause);
		await s.invoke();

		expect(s.notify).not.toHaveBeenCalled();
		expect(s.issue.notes).toBe("Keep existing notes unchanged.");
		expect(s.sendUserMessage).toHaveBeenCalledOnce();
		const kickoff = s.sendUserMessage.mock.calls[0][0];
		expect(kickoff).toContain("First reply with a brief state summary and proposed next action");
		expect(kickoff).toContain("Do not implement or write tests in this first turn");
		expect(kickoff).toContain(`Continuation: ${pause ? "paused" : "one increment"}`);
		if (pause) expect(kickoff).toContain("Remain paused until the outstanding review, approval, or blocker is resolved");

		const path = s.replacement()!.getSessionFile()!;
		expect(existsSync(path)).toBe(true);
		const restored = SessionManager.open(path);
		expect(restored.getHeader()?.parentSession).toBe(s.original.getSessionFile());
		expect(restored.getBranch()).toContainEqual(expect.objectContaining({
			type: "custom_message", customType: "task-checkpoint", content: expect.stringContaining("Finish the agreed caller"),
		}));
		expect(restored.getBranch()).toContainEqual(expect.objectContaining({
			type: "custom", customType: "task-workflow", data: expect.objectContaining({ taskId: "bd-task" }),
		}));
	});

	it("summarizes a blocked task without authorizing implementation", async () => {
		const s = checkpointSession(false, "blocked");
		await s.invoke();
		expect(s.sendUserMessage.mock.calls[0][0]).toContain("Continuation: paused");
		expect(s.sendUserMessage.mock.calls[0][0]).toContain("Task status is blocked");
	});

	it("inserts steering literally, including replacement metacharacters", async () => {
		const s = checkpointSession(false);
		const steering = "Keep $& $$ $` $' and $1 literally.";
		await s.invoke(steering);
		expect(s.sendUserMessage.mock.calls[0][0]).toContain(`Additional steering from the user:\n${steering}\n`);
	});
});
