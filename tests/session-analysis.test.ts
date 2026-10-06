import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import analyzeSessionExtension, { analyzeSession, formatSessionAnalysis } from "../extensions/analyze-session.ts";

type Assistant = Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function usage(input: number, cacheRead = 0, cacheWrite = 0, output = 10, cost = 0.1) {
	return {
		input, cacheRead, cacheWrite, output, totalTokens: input + cacheRead + cacheWrite + output,
		cost: { input: cost, cacheRead: 0, cacheWrite: 0, output: 0, total: cost },
	};
}

function assistant(input: number, options: Partial<Assistant> & { thinkingLevel?: string } = {}): Assistant {
	return {
		role: "assistant", content: [], api: "openai-responses", provider: "test", model: "sol",
		stopReason: "stop", timestamp: 1, usage: usage(input), ...options,
	};
}

function analyze(session: SessionManager) {
	return analyzeSession(session.getBranch(), session.getEntries());
}

describe("persisted session economics", () => {
	it("includes compacted ancestry, excludes abandoned requests from branch metrics, and separates whole-file spending", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-analysis-"));
		roots.push(root);
		const session = SessionManager.create(root, root);
		const start = session.appendMessage({ role: "user", content: "Start", timestamp: 0 });
		session.appendMessage(assistant(100, { usage: usage(100, 900, 50, 100, 1) }));
		const retained = session.appendMessage(assistant(200, { usage: usage(200, 0, 0, 20, 2) }));
		session.appendCompaction("A summary", retained, 1500, undefined, false, usage(100, 0, 0, 10, 0.5));
		session.appendMessage(assistant(50, { usage: usage(50, 100, 0, 10, 0.3) }));
		const activeLeaf = session.getLeafId()!;
		session.branch(start);
		session.appendMessage(assistant(9999, { model: "abandoned", usage: usage(9999, 0, 0, 10, 9) }));
		session.branch(activeLeaf);
		const path = session.getSessionFile()!;
		const before = readFileSync(path, "utf8");
		const report = analyze(session);
		expect(report.models).toHaveLength(1);
		expect(report.models[0].calls).toBe(3);
		expect(report.models[0].prompts).toEqual([1050, 200, 150]);
		expect(report.models[0].growth).toEqual([-850]);
		expect(report.branch.cost).toBeCloseTo(3.8);
		expect(report.wholeFile.cost).toBeCloseTo(12.8);
		expect(report.offBranch.cost).toBe(9);
		expect(report.epochs[0].lastReportedPrompt).toBe(200);
		expect(readFileSync(path, "utf8")).toBe(before);
		// The saved JSONL retains the ancestry even though the context projection omits it.
		const restored = SessionManager.open(path);
		const active = restored.getBranch(activeLeaf);
		expect(analyzeSession(active, restored.getEntries()).branch).toEqual(report.branch);
	});

	it("uses token-weighted cache share, does not double-count reasoning, and computes descriptive distributions", () => {
		const session = SessionManager.inMemory();
		session.appendThinkingLevelChange("high");
		session.appendMessage(assistant(10, { usage: { ...usage(10, 90, 0, 30), reasoning: 20 } }));
		session.appendMessage(assistant(900, { usage: usage(900, 0, 0, 40) }));
		const report = analyze(session);
		expect(report.models[0].expenditure).toMatchObject({
			prompt: 1000, input: 910, cacheRead: 90, output: 70, reasoning: 20, reasoningRecords: 1,
		});
		expect(report.models[0].growth).toEqual([800]);
		const formatted = formatSessionAnalysis(report);
		expect(formatted).toContain("Weighted cached-input share 9.0%");
		expect(formatted).toContain("median 500, p90 900, max 900 (n=2)");
		expect(formatted).toContain("thinking high");
		expect(formatted).toContain("reasoning 20 (1/2 reported; included in output)");
	});

	it("reports missing and zero coverage while keeping failed/aborted expenditure out of prompt samples", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(assistant(100));
		session.appendMessage(assistant(0, { usage: usage(0, 0, 0, 0, 0) }));
		session.appendMessage(assistant(200, { stopReason: "error", usage: usage(200, 0, 0, 10, 0.2) }));
		session.appendMessage(assistant(300, { stopReason: "aborted" }));
		session.appendMessage(assistant(400, { stopReason: "deferred" }));
		session.appendMessage(assistant(500));
		const report = analyze(session);
		expect(report.models[0]).toMatchObject({
			calls: 6, successful: 3, usableSuccessful: 2, failed: 1, aborted: 1, other: 1, missingUsage: 1,
			prompts: [100, 500], growth: [],
			expenditure: { prompt: 1500, costRecords: 6, zeroCostRecords: 1, usable: 5 },
		});
		expect(formatSessionAnalysis(report)).toContain("does not prove zero expenditure");
	});

	it("tolerates historical absent/partial/invalid usage and pricing without fabricating measurements", () => {
		const session = SessionManager.inMemory();
		for (const value of [undefined, { input: 12 }, { ...usage(100), cacheRead: -1 }, { ...usage(100), input: NaN }]) {
			session.appendMessage(assistant(0, { usage: value as Assistant["usage"] }));
		}
		session.appendMessage(assistant(100, { usage: { ...usage(100), cost: undefined } as unknown as Assistant["usage"] }));
		const report = analyze(session);
		expect(report.models[0]).toMatchObject({ missingUsage: 4, prompts: [100], growth: [] });
		expect(report.branch).toMatchObject({ records: 5, usable: 1, costRecords: 2, cost: 0.2 });
		const formatted = formatSessionAnalysis(report);
		expect(formatted).not.toMatch(/NaN|Infinity/);
		expect(formatted).toContain("thinking unknown");
	});

	it("resets growth across configuration changes, edits, prompt changes, and summaries; warming stays auxiliary", () => {
		const session = SessionManager.inMemory();
		const a = session.appendMessage(assistant(100, { thinkingLevel: "low" }));
		session.appendMessage(assistant(200, { thinkingLevel: "high" }));
		session.appendMessage(assistant(300, { thinkingLevel: "low" }));
		session.appendContextEdit(a, null);
		session.appendMessage(assistant(400, { thinkingLevel: "low" }));
		session.appendMessage({ role: "system", content: "Changed tools", timestamp: 2 });
		session.appendMessage(assistant(500, { thinkingLevel: "low" }));
		session.appendModelChange("test", "sol");
		session.appendMessage(assistant(600, { thinkingLevel: "low" }));
		session.appendThinkingLevelChange("low");
		session.appendMessage(assistant(700, { thinkingLevel: "low" }));
		session.appendUsage("cache_warm", "test", "sol", usage(0, 700, 0, 0, 0.02));
		session.appendMessage(assistant(800, { thinkingLevel: "low" }));
		const report = analyze(session);
		expect(report.models).toHaveLength(2);
		expect(report.models[0].growth).toEqual([100]);
		expect(report.models[0].prompts).toEqual([100, 300, 400, 500, 600, 700, 800]);
		expect(report.cacheWarmings).toBe(1);
		expect(report.auxiliary[0].expenditure.cacheRead).toBe(700);
		expect(report.models[0].expenditure.cacheRead).toBe(0);
		expect(report.branch.cacheRead).toBe(700);
	});

	it("shows first post-compaction rebuilding separately, counts all interval usage, and leaves later epochs unmeasured", () => {
		const session = SessionManager.inMemory();
		const original = session.appendMessage(assistant(1000));
		session.appendCompaction("Summary", original, 1100, undefined, false, usage(1000, 0, 0, 30, 0.4));
		session.appendMessage(assistant(500, { usage: usage(400, 0, 100, 10, 0.2) }));
		session.appendUsage("cache_warm", "test", "sol", usage(0, 500, 0, 0, 0.01));
		session.appendUsage("future-kind", "test", "sol", usage(10, 0, 0, 5, 0.03));
		session.appendMessage(assistant(20, { usage: usage(20, 500, 0, 10, 0.05) }));
		session.appendMessage({ role: "toolResult", content: [], toolCallId: "a", toolName: "nested", isError: false, timestamp: 1, usage: usage(30, 0, 0, 20, 0.02) });
		const leaf = session.getLeafId()!;
		session.branchWithSummary(leaf, "Context-changing summary", undefined, false, usage(100, 0, 0, 10, 0.1));
		session.appendMessage(assistant(9000));
		session.appendCompaction("Unmeasured summary", leaf, 10000);
		const report = analyze(session);
		expect(report.epochs).toHaveLength(2);
		expect(report.epochs[0]).toMatchObject({
			requests: 2, tokensBefore: 1100, endedBy: "branch_summary",
			firstReported: { prompt: 500, request: 1, expenditure: { input: 400, cacheWrite: 100, cost: 0.2 } },
			subsequent: { cacheRead: 1000, cost: 0.11 },
		});
		expect(report.epochs[1].firstReported).toBeUndefined();
		expect(report.epochs[0].observed.cost).toBeCloseTo(0.31);
		expect(report.epochs[1].summary.usable).toBe(0);
		expect(report.branchSummaries).toBe(1);
		expect(report.auxiliary.find((item) => item.kind.includes("nested tool"))?.expenditure.output).toBe(20);
		const formatted = formatSessionAnalysis(report);
		expect(formatted).toContain("First measured request, including rebuilding");
		expect(formatted).toContain("First subsequent reported prompt: unknown");
		expect(formatted).toContain("Later cache reuse: unknown cached tokens");
		expect(formatted).toContain("insufficient evidence for an optimal threshold");
	});

	it("ends epochs and growth comparisons when request-level routing changes without model-change entries", () => {
		const session = SessionManager.inMemory();
		session.appendCompaction("Summary", null, 2000);
		session.appendMessage(assistant(600, { thinkingLevel: "low" }));
		session.appendMessage(assistant(700, { thinkingLevel: "high" }));
		session.appendMessage(assistant(800, { thinkingLevel: "low", providerThinkingLevel: "provider-low" }));
		const report = analyze(session);
		expect(report.epochs[0]).toMatchObject({ requests: 1, endedBy: "assistant model/configuration change" });
		expect(report.epochs[0].observed.prompt).toBe(600);
		expect(report.models).toHaveLength(3);
		expect(report.models.every((model) => model.growth.length === 0)).toBe(true);
	});

	it("identifies later measured requests instead of claiming first-request rebuilding was observed", () => {
		const session = SessionManager.inMemory();
		session.appendCompaction("Summary", null, 2000);
		session.appendMessage(assistant(0, { stopReason: "error", usage: usage(0, 0, 0, 0, 0) }));
		session.appendMessage(assistant(600));
		const report = analyze(session);
		expect(report.epochs[0].firstReported?.request).toBe(2);
		expect(formatSessionAnalysis(report)).toContain("600 (request 2; stop)");
		expect(formatSessionAnalysis(report)).toContain("first-request rebuilding unmeasured");
	});
});

describe("/analyze-session read-only command", () => {
	function command() {
		let handler: RegisteredCommand["handler"];
		// Deliberately expose only command registration; writes/hooks/model calls would fail.
		analyzeSessionExtension({ registerCommand: (name: string, value: RegisteredCommand) => {
			expect(name).toBe("analyze-session"); handler = value.handler;
		} } as unknown as ExtensionAPI);
		return (args: string, ctx: Partial<Omit<ExtensionCommandContext, "ui">> & { ui?: Pick<ExtensionCommandContext["ui"], "notify"> }) =>
			handler(args, ctx as ExtensionCommandContext);
	}

	it("displays a report without changing the leaf or entries, and rejects arguments", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage(assistant(100));
		const before = structuredClone(session.getEntries());
		const leaf = session.getLeafId();
		const notify = vi.fn();
		const invoke = command();
		await invoke("", { sessionManager: session, hasUI: true, mode: "rpc", ui: { notify } });
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Whole file / all branches"), "info");
		expect(session.getEntries()).toEqual(before);
		expect(session.getLeafId()).toBe(leaf);
		await invoke("all", { ui: { notify } });
		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Usage:"), "warning");
	});

	it("prints JSON-mode output without needing UI or a model", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await command()("", { sessionManager: SessionManager.inMemory(), hasUI: false, mode: "json" });
			expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ type: "session_analysis", report: expect.stringContaining("insufficient evidence") });
		} finally { log.mockRestore(); }
	});
});
