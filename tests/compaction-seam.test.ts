import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { compactionSeamCases } from "./compaction-seam-probe.ts";

describe(`compaction seam (repository SDK ${VERSION})`, () => {
  for (const [name, run] of Object.entries(compactionSeamCases)) {
    it(name, async () => { await run(); }, 10_000);
  }
});

// Opt in: PI_COMPACTION_PROBE_CLI=$(command -v pi) npm test -- tests/compaction-seam.test.ts
it.skipIf(!process.env.PI_COMPACTION_PROBE_CLI)("probes the installed CLI's embedded SDK offline", async () => {
  const executable = process.env.PI_COMPACTION_PROBE_CLI;
  if (!executable) throw new Error("PI_COMPACTION_PROBE_CLI must select an installed Pi executable");
  const root = await mkdtemp(join(tmpdir(), "pi-compaction-cli-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { mode: 0o700 });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    }));
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, [
        "--mode", "rpc", "--offline", "--no-approve", "--no-session", "--no-tools", "--no-extensions",
        "--no-mcp", "--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files",
        "--extension", fileURLToPath(new URL("./compaction-seam-probe.ts", import.meta.url)),
        "--provider", "compaction-seam-probe", "--model", "offline-fixture",
      ], {
        cwd: root,
        // Exclude credentials, ambient resources, and parent session markers.
        env: {
          PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, XDG_CACHE_HOME: root,
          PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Compaction CLI probe timed out\n${stdout}\n${stderr}`));
      }, 30_000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes('"disposition":"handled"')) child.stdin.end();
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`CLI exited ${code}/${signal}\n${stdout}\n${stderr}`));
        else resolve(stdout);
      });
      child.stdin.on("error", () => { /* Process error/close diagnoses early exit. */ });
      child.stdin.write(JSON.stringify({ id: "probe", type: "prompt", message: "/compaction-seam-probe" }) + "\n");
    });
    const record = output.split("\n").find((line) => line.startsWith('{"compactionSeamProbe'));
    expect(record, output).toBeDefined();
    if (!record) throw new Error("CLI did not return a compaction probe record");
    const decoded: unknown = JSON.parse(record);
    expect(decoded).not.toHaveProperty("compactionSeamProbeError");
    expect(decoded).toHaveProperty("compactionSeamProbe.version", "1.3.0");
    expect(decoded).toHaveProperty("compactionSeamProbe.checks");
    console.log(JSON.stringify({ executable: await realpath(executable), result: decoded }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 35_000);
