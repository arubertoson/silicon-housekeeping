import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import splitExtension from "../extensions/split.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	vi.unstubAllEnvs();
});

async function harness(scenario = "ok", saved = true) {
	const root = mkdtempSync(join(tmpdir(), "pi-split-fork-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project with 'spaces");
	const bin = join(root, "bin");
	mkdirSync(cwd);
	mkdirSync(bin);
	writeFileSync(join(root, "scenario"), scenario);
	// Only process launch is substituted; Pi loads the extension and serializes real sessions.
	writeFileSync(join(bin, "dev-workspace"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FORK_TEST_ROOT;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(args) + "\\n");
const scenario = fs.readFileSync(path.join(root, "scenario"), "utf8");
if (args[0] === "pane-can-add") {
	if (scenario === "full") { console.error("four-pane limit reached"); process.exit(2); }
	if (scenario === "hold") {
		fs.writeFileSync(path.join(root, "checking"), "");
		const timer = setInterval(() => {
			if (fs.existsSync(path.join(root, "release"))) { clearInterval(timer); process.exit(0); }
		}, 5);
		setTimeout(() => process.exit(1), 3000).unref();
	}
} else if (args[0] === "pane-run") {
	if (scenario === "race") { console.error("four-pane limit reached"); process.exit(2); }
	if (scenario === "unknown") { console.error("placement failed after launch"); process.exit(1); }
	console.log("%42");
} else { process.exit(1); }
`, { mode: 0o755 });
	vi.stubEnv("FORK_TEST_ROOT", root);
	vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
	vi.stubEnv("TMUX", "/tmp/test-socket,123,0");
	vi.stubEnv("TMUX_PANE", "%7");

	const manager = saved ? SessionManager.create(cwd, join(root, "sessions")) : SessionManager.inMemory(cwd);
	manager.appendModelChange("split-test", "local");
	const first = manager.appendMessage({ role: "user", content: "Shared context", timestamp: 1 });
	const leaf = manager.appendMessage({ role: "user", content: "Selected branch", timestamp: 2 });
	manager.appendLabelChange(first, "shared");
	manager.branch(first);
	manager.appendMessage({ role: "user", content: "Abandoned alternative", timestamp: 3 });
	manager.branch(leaf);

	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false,
	});
	modelRuntime.registerProvider("split-test", {
		api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "offline",
		models: [{ id: "local", name: "Offline", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	});
	const loader = new DefaultResourceLoader({
		cwd, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [splitExtension],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd, agentDir: root, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: manager,
		model: modelRuntime.getModel("split-test", "local")!, thinkingLevel: "off", noTools: "all",
	});
	cleanup.push(() => session.dispose());
	const notices: { message: string; type?: string }[] = [];
	const errors: string[] = [];
	await session.bindExtensions({
		mode: "tui",
		uiContext: { notify: (message, type) => notices.push({ message, type }) } as ExtensionUIContext,
		onError: (error) => errors.push(error.error),
	});
	const shortcut = session.extensionRunner.getShortcuts({}).get("alt+shift+o");
	expect(shortcut).toBeDefined();
	return {
		root, cwd, manager, session, notices, errors,
		files: () => saved ? readdirSync(join(root, "sessions")).filter((name) => name.endsWith(".jsonl")) : [],
		calls: (): string[][] => {
			try { return readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		},
		shortcut: () => shortcut!.handler(session.extensionRunner.createContext()),
	};
}

describe("tmux split fork mode through Pi's real extension runtime", () => {
	it("Alt+Shift+O snapshots only the selected branch without changing the parent", async () => {
		const h = await harness();
		const file = h.manager.getSessionFile()!;
		const before = readFileSync(file, "utf8");
		const id = h.manager.getSessionId();
		const leaf = h.manager.getLeafId();
		await h.shortcut();
		expect(h.errors).toEqual([]);
		expect(h.calls().map((args) => args[0])).toEqual(["pane-can-add", "pane-run"]);
		const launch = h.calls()[1];
		expect(launch.slice(0, 3)).toEqual(["pane-run", "%7", h.cwd]);
		expect(launch[3]).toBe(process.execPath);
		const forkFile = launch[launch.indexOf("--session") + 1];
		const fork = SessionManager.open(forkFile);
		expect(fork.getHeader()?.parentSession).toBe(file);
		expect(fork.getSessionId()).not.toBe(id);
		expect(fork.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => entry.message.content)).toEqual(["Shared context", "Selected branch"]);
		expect(fork.getLabel(h.manager.getBranch()[1].id)).toBe("shared");
		expect(h.manager.getSessionFile()).toBe(file);
		expect(h.manager.getSessionId()).toBe(id);
		expect(h.manager.getLeafId()).toBe(leaf);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(h.notices).toEqual([]);
	});

	it("the slash command passes an optional prompt as one literal argument", async () => {
		const h = await harness();
		const prompt = "-inspect 'quoted paths'; do not run shell commands";
		await h.session.prompt(`/split fork ${prompt}`);
		const launch = h.calls()[1];
		expect(launch.slice(-2)).toEqual(["--", prompt]);
		expect(h.files()).toHaveLength(2);
		expect(h.errors).toEqual([]);
	});

	it.each(["full", "race"])("does not leave an unused fork when capacity is refused: %s", async (scenario) => {
		const h = await harness(scenario);
		const files = h.files();
		await h.shortcut();
		expect(h.files()).toEqual(files);
		expect(h.notices.at(-1)?.message).toContain("four-pane limit");
		expect(h.calls()).toHaveLength(scenario === "full" ? 1 : 2);
	});

	it("retains the fork on ambiguous launch failures instead of deleting or retrying it", async () => {
		const h = await harness("unknown");
		await h.shortcut();
		expect(h.files()).toHaveLength(2);
		expect(h.calls()).toHaveLength(2);
		expect(h.notices.at(-1)?.message).toContain("Fork preserved at");
	});

	it("pins the invocation leaf while the parent appends during the capacity check", async () => {
		const h = await harness("hold");
		const opening = h.shortcut();
		await expect.poll(() => readdirSync(h.root).includes("checking")).toBe(true);
		await h.shortcut();
		expect(h.calls()).toHaveLength(1);
		const later = h.manager.appendMessage({ role: "user", content: "Later parent work", timestamp: 4 });
		writeFileSync(join(h.root, "release"), "");
		await opening;
		const args = h.calls()[1];
		const fork = SessionManager.open(args[args.indexOf("--session") + 1]);
		expect(fork.getBranch().some((entry) => entry.id === later)).toBe(false);
		expect(h.manager.getLeafId()).toBe(later);
	});

	it("refuses outside tmux and for ephemeral sessions without creating artifacts", async () => {
		const h = await harness("ok", false);
		await h.shortcut();
		expect(h.calls()).toEqual([]);
		expect(h.notices.at(-1)?.message).toContain("No saved conversation");
		vi.stubEnv("TMUX", "");
		await h.shortcut();
		expect(h.calls()).toEqual([]);
		expect(h.notices.at(-1)?.message).toContain("requires a tmux pane");
	});
});
