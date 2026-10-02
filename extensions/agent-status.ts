import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type AgentStatus = "idle" | "running" | "waiting" | "ready";

const STATUS_DIR = join(
	process.env.XDG_RUNTIME_DIR || process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
	"pi-agents",
);
const PID = String(process.pid);
const PANE_ID = process.env.TMUX_PANE || "";
const TMUX_SERVER = process.env.TMUX?.split(",").slice(0, 2).join(",") || "";

function line(value: string): string {
	return value.replace(/[\x00-\x1f\x7f]/g, " ");
}

function sessionLabel(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName() || "Pi";
}

export default function agentStatusExtension(pi: ExtensionAPI) {
	const INSTANCE_ID = randomUUID();
	const STATUS_FILE = join(STATUS_DIR, `${INSTANCE_ID}.status`);
	let status: AgentStatus = "idle";
	let changedAt = Math.floor(Date.now() / 1000);
	// Keep completion identities distinct when this runtime changes sessions.
	let completions = 0;
	let label = "Pi session";
	let project = "";
	let previousStatus: AgentStatus = "idle";
	let statusFile: string | undefined;

	async function publish(next: AgentStatus) {
		if (!statusFile) return;
		if (status !== next) {
			status = next;
			changedAt = Math.floor(Date.now() / 1000);
		}
		// Shared v1 protocol: version, instance, PID, pane, tmux server, status,
		// status-change epoch, completion count, project path, session label.
		const contents = [
			"1",
			INSTANCE_ID,
			PID,
			PANE_ID,
			TMUX_SERVER,
			status,
			String(changedAt),
			String(completions),
			line(project),
			line(label),
		].join("\n");

		await mkdir(STATUS_DIR, { recursive: true, mode: 0o700 });
		await chmod(STATUS_DIR, 0o700);
		const temporary = `${statusFile}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${contents}\n`, { mode: 0o600 });
			await rename(temporary, statusFile);
		} catch (error) {
			await rm(temporary, { force: true });
			throw error;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		statusFile = STATUS_FILE;
		project = ctx.cwd;
		label = sessionLabel(ctx);
		status = "idle";
		changedAt = Math.floor(Date.now() / 1000);
		await publish(status);
	});

	pi.on("agent_start", async (_event) => {
		await publish("running");
	});

	pi.on("agent_settled", async (_event) => {
		completions += 1;
		await publish("ready");
	});

	pi.on("ui_prompt_start", async (_event) => {
		previousStatus = status;
		await publish("waiting");
	});

	pi.on("ui_prompt_end", async (_event) => {
		if (status === "waiting") await publish(previousStatus);
	});

	pi.on("session_shutdown", async () => {
		if (statusFile) await rm(statusFile, { force: true });
	});
}
