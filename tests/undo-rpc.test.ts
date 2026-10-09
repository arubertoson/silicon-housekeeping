import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

it("undo works through the actual CLI/RPC editor protocol, including first-turn and before/after-text aborts", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-undo-rpc-"));
	const requests: unknown[] = [];
	const events: unknown[] = [];
	let hold: "before-text" | "after-text" | undefined;
	let received: (() => void) | undefined;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		requests.push(JSON.parse(body));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.flushHeaders();
		const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		if (hold !== "before-text") chunk({ role: "assistant", content: "Offline answer" });
		received?.();
		if (!hold) { chunk({}, "stop"); res.end("data: [DONE]\n\n"); }
	});
	let client: RpcClient | undefined;
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { "undo-local": {
			baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "offline",
			models: [{ id: "local", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1000 }],
		} } }));
		writeFileSync(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } }));
		writeFileSync(join(root, "template.md"), "Expanded $1");
		client = new RpcClient({
			cliPath: join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js"),
			cwd: root, env: { PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
			provider: "undo-local", model: "local",
			args: ["--no-extensions", "--no-skills", "--no-themes", "--no-context-files", "--no-tools", "--no-approve", "--no-prompt-templates", "--thinking", "off", "--session-dir", join(root, "sessions"), "--extension", fileURLToPath(new URL("../extensions/undo.ts", import.meta.url)), "--prompt-template", join(root, "template.md")],
		});
		client.onEvent((event) => events.push(event));
		await client.start();
		const state = await client.getState();
		const initial = await client.getEntries();
		await client.promptAndWait("/template mistaken", undefined, 5000);
		expect(await client.prompt("/undo")).toBe("handled");
		expect(events).toContainEqual(expect.objectContaining({ type: "extension_ui_request", method: "set_editor_text", text: "/template mistaken" }));
		expect(await client.getEntries()).toEqual(initial);
		expect(await client.getMessages()).toEqual([]);
		expect(SessionManager.open(state.sessionFile!).getEntries()).toEqual(initial.entries);
		await client.promptAndWait("Corrected first prompt", undefined, 5000);
		expect(JSON.stringify(requests.at(-1))).not.toContain("mistaken");

		for (const stage of ["before-text", "after-text"] as const) {
			const before = await client.getEntries();
			hold = stage;
			const request = new Promise<void>((resolve) => { received = resolve; });
			let resolveText: (() => void) | undefined;
			const text = new Promise<void>((resolve) => { resolveText = resolve; });
			const unsubscribe = client.onEvent((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") resolveText?.();
			});
			await client.prompt(`Mistaken ${stage}`);
			await request;
			if (stage === "after-text") await text;
			expect((await client.getState()).isStreaming).toBe(true);
			expect(await client.prompt("/undo")).toBe("handled");
			unsubscribe();
			expect(events).toContainEqual(expect.objectContaining({ type: "extension_ui_request", method: "set_editor_text", text: `Mistaken ${stage}` }));
			expect(await client.getEntries()).toEqual(before);
			expect(SessionManager.open(state.sessionFile!).getEntries()).toEqual(before.entries);
			expect((await client.getState()).sessionId).toBe(state.sessionId);
			hold = undefined; received = undefined;
			await client.promptAndWait(`Corrected ${stage}`, undefined, 5000);
			expect(JSON.stringify(requests.at(-1))).not.toContain("Mistaken");
		}
		expect(events).not.toContainEqual(expect.objectContaining({ type: "extension_ui_request", method: "notify", notifyType: "error" }));
		expect(readdirSync(join(root, "sessions"))).toEqual([state.sessionFile!.split("/").at(-1)]);
		expect(client.getStderr()).toBe("");
	} finally {
		await client?.stop();
		await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);
