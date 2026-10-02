import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("Pi agent status publisher", () => {
	it("publishes lifecycle state in the shared record and removes it on shutdown", async () => {
		const runtime = await mkdtemp(join(tmpdir(), "pi-agent-status-"));
		roots.push(runtime);
		vi.stubEnv("XDG_RUNTIME_DIR", runtime);
		vi.resetModules();

		const { default: extension } = await import("../extensions/agent-status.ts");
		const handlers = new Map<string, unknown>();
		extension({
			on: (event: string, handler: unknown) => {
				handlers.set(event, handler);
				return () => {};
			},
		} as unknown as ExtensionAPI);

		const ctx = {
			cwd: "/tmp/example-project",
			sessionManager: { getSessionName: () => "review session" },
		};
		const fire = async (event: string, context = ctx) => {
			const handler = handlers.get(event);
			if (typeof handler !== "function") throw new Error(`Missing ${event} handler`);
			await (handler as (event: unknown, context: unknown) => unknown)({}, context);
		};
		const statusDir = join(runtime, "pi-agents");

		await fire("session_start");
		const files = await readdir(statusDir);
		expect(files).toHaveLength(1);
		const path = join(statusDir, files[0]!);
		const record = async () => (await readFile(path, "utf8")).trimEnd().split("\n");
		let fields = await record();
		expect(fields).toHaveLength(10);
		expect(fields[0]).toBe("1");
		expect(fields[2]).toBe(String(process.pid));
		expect(fields[5]).toBe("idle");
		expect(fields[7]).toBe("0");
		expect(fields[8]).toBe(ctx.cwd);
		expect(fields[9]).toBe("review session");

		await fire("agent_start");
		await fire("ui_prompt_start");
		fields = await record();
		expect(fields[5]).toBe("waiting");
		await fire("ui_prompt_end");
		fields = await record();
		expect(fields[5]).toBe("running");
		await fire("agent_settled");
		fields = await record();
		expect(fields[5]).toBe("ready");
		expect(fields[7]).toBe("1");

		await fire("session_shutdown");
		expect(await readdir(statusDir)).toEqual([]);
	});
});
