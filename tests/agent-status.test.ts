import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.resetModules();
});

async function startPublisher(name?: string) {
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

	const session = { name };
	const ctx = {
		cwd: "/tmp/example-project",
		sessionManager: { getSessionName: () => session.name },
	};
	const fire = async (event: string) => {
		const handler = handlers.get(event);
		if (typeof handler !== "function") throw new Error(`Missing ${event} handler`);
		await (handler as (event: unknown, context: unknown) => unknown)({}, ctx);
	};
	const statusDir = join(runtime, "pi-agents");
	await fire("session_start");
	const files = await readdir(statusDir);
	expect(files).toHaveLength(1);
	const path = join(statusDir, files[0]!);
	const record = async () => (await readFile(path, "utf8")).trimEnd().split("\n");
	return { session, ctx, fire, statusDir, record };
}

describe("Pi agent status publisher", () => {
	it.each([undefined, "", " \t\n "])("uses a PID fallback for an unnamed session (%j)", async (name) => {
		const { record } = await startPublisher(name);
		expect((await record())[9]).toBe(`Pi (${process.pid})`);
	});

	it("refreshes renamed and cleared labels without changing lifecycle fields", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
		const { session, fire, record } = await startPublisher();
		await fire("agent_start");
		await fire("agent_settled");
		const before = await record();
		now.mockReturnValue(1_700_000_060_000);

		session.name = "review parser\nregressions\t\x1b";
		await fire("session_info_changed");
		const renamed = await record();
		expect(renamed).toHaveLength(10);
		expect(renamed.slice(0, 9)).toEqual(before.slice(0, 9));
		expect(renamed[9]).toBe("review parser regressions");

		session.name = undefined;
		await fire("session_info_changed");
		const cleared = await record();
		expect(cleared.slice(0, 9)).toEqual(before.slice(0, 9));
		expect(cleared[9]).toBe(`Pi (${process.pid})`);
	});

	it("publishes lifecycle state in the shared record and removes it on shutdown", async () => {
		const { ctx, fire, statusDir, record } = await startPublisher("review session");
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
