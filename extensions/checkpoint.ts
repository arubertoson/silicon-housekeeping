import { readFile } from "node:fs/promises";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	serializeConversation,
	stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { VCS_LOG_INSTRUCTIONS } from "./command-context.ts";
import { RECONCILIATION_INSTRUCTIONS } from "../support/checkpoint.ts";

const Workflow = Type.Object({
	taskId: Type.String({ minLength: 1 }),
	mode: Type.Union([Type.Literal("implement-step"), Type.Literal("implement-coach")]),
	cwd: Type.String({ minLength: 1 }),
	vcs: Type.Union([Type.Literal("git"), Type.Literal("jj")]),
	prompt: Type.String({ minLength: 1 }),
});

const Issue = Type.Object({
	id: Type.String({ minLength: 1 }),
	title: Type.String({ minLength: 1 }),
	status: Type.String({ minLength: 1 }),
	assignee: Type.Optional(Type.String()),
	notes: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	design: Type.Optional(Type.String()),
	acceptance_criteria: Type.Optional(Type.String()),
});

const Checkpoint = Type.Object(
	{
		checkpoint: Type.String({ minLength: 1 }),
		pause: Type.Boolean(),
		reason: Type.String({ minLength: 1 }),
		tests: Type.Union([Type.Literal("deferred"), Type.Literal("allowed")]),
		testScope: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const CHECKPOINT_PROMPT = `Extract a continuation checkpoint for the current session; do not implement anything. You have no tools. This is a continuation contract, not a session summary. The host performs read-only Beads lookups when a task is bound, validation, and session replacement. The checkpoint is carried in the replacement session, not written to Beads notes. Return only a JSON object matching the supplied schema.

Reconcile accepted state:
- When a task is bound, reconcile only that task and its existing issue context; do not import agreements from unrelated tasks. When no task is bound, use the existing session conversation as the sole scope.
${RECONCILIATION_INSTRUCTIONS}
- Pause for consequential ambiguity.
- Save accepted decisions and outstanding approvals in the checkpoint only. Do not rewrite task description, design, acceptance criteria, scope, status, ownership, dependencies, or other issues. Do not propose separate handoff or TODO files.

Continuation and approval gates:
- The caller authorizes a context reset and at most one next increment within the saved boundaries, not completion of the task. A reset is not design approval.
- Set pause=true if review, approval, a consequential decision, missing context, or a blocker prevents continuation. Describe why continuation is allowed or paused in reason.
- Set tests=allowed only for behavior whose code shape the user explicitly accepted or whose tests they requested; otherwise deferred. In testScope identify that specific behavior/increment and the approval supporting it, or state that no tests are authorized. Completed test work does not authorize tests for later increments. Never turn a scoped approval into task-wide permission.

Checkpoint body:
- Write Markdown using ### subheadings, WITHOUT the enclosing ## Continuation checkpoint heading. Aim for 350 words without sacrificing active agreements.
- Use applicable headings: Goal; Active agreements and prohibitions; Accepted direction and essential rationale; Current implementation and verification; Genuine blockers or unresolved decisions; Review and test approval; Immediate next action; Relevant file paths and related issue IDs.
- Distinguish passed, failed, and not-run checks, observations from assumptions, and recorded verification from current working-copy state. Do not invent fresh verification. Include branch/commit and uncommitted-work caveats when useful.
- Drop chronology, debugging transcripts, and resolved discussion, not the resulting decisions or constraints. Prefer references for recoverable implementation details, but state agreements explicitly. A rejected approach may remain an active prohibition.
- Before returning, check the draft against the available agreements and corrections: would a fresh agent know what to do, what not to do, and why? Repair omissions rather than relying on the user to rediscover them.

JSON schema:
${JSON.stringify(Checkpoint)}`;

const RESTORE_TASK_PROMPT = `Continue work on Beads issue "$1".

Additional steering from the user:
$STEERING

- If no issue ID was supplied, ask for one and stop. Follow the Beads skill and repository instructions.
- Check the active Beads workspace. If missing or the issue cannot be found, ask for the correct workspace or ID. Do not initialize a workspace or substitute a different issue.
- Read the continuation checkpoint carried in this session and \`bd show <id>\`, including its current description, acceptance criteria, design, and notes. Older checkpoints in issue notes are historical evidence, not the current handoff. Treat the restored state as the starting point, not as proof that the working tree still matches it.
- Load only relevant parent constraints, active blockers, and source files needed for the immediate next action. Do not load the whole backlog, all comments, or old session transcripts. Retrieve history only to resolve a specific consequential gap.
- Check relevant repository/working-tree state before editing. Preserve existing work. Distinguish recorded verification from fresh verification; do not assume a past passing check proves the present tree passes.
- If the issue is closed, superseded, blocked, or owned by another worker, explain and resolve that condition before implementation. Do not automatically reopen, take over, or switch to a replacement issue. Reading or resuming does not authorize claiming or changing task records; leave ownership and status unchanged unless explicitly requested.
- Reconcile additional steering with the saved state. Ask only when a consequential conflict or missing decision prevents safe continuation. Do not reopen settled decisions or revive abandoned work without a concrete reason.
- Preserve the selected implementation or coaching role and any pending review. Test approval applies only to the behavior or increment explicitly approved, not all future work. If invoked alone, default to implementation; use the caller-first approach in the \`application-design\` skill.
- In your first reply, briefly summarize the current goal, accepted direction, implementation and recorded verification, outstanding review or approval gates, and the proposed immediate next action. This is a state summary, not a retrospective. Do not implement or write tests in this first turn; wait for user follow-up. If paused for review or approval, remain paused until it is resolved. Later continuation permits at most one reviewable increment, not the whole task.`;

const RESTORE_SESSION_PROMPT = `Continue from the existing session's conversation and the continuation checkpoint carried in this session. There is no bound Beads task; do not ask for a task ID, look up or create a task, or invent task-specific context.

Additional steering from the user:
$STEERING

- Treat the saved checkpoint as the accepted-state handoff and the original conversation as evidence. Reconcile the checkpoint with the session history, preserving explicit agreements and corrections; do not revive abandoned work or treat suggestions as commitments.
- Check relevant repository/working-tree state before editing. Preserve existing work. Distinguish recorded verification from fresh verification; do not assume a past passing check proves the present tree passes.
- Ask only when a consequential conflict or missing decision prevents safe continuation. Do not reopen settled decisions.
- If invoked alone, default to implementation and use the caller-first approach in the \`application-design\` skill. Test approval applies only to the behavior or increment explicitly approved, not all future work.
- In your first reply, briefly summarize the current goal, accepted direction, implementation and recorded verification, outstanding review or approval gates, and the proposed immediate next action. This is a state summary, not a retrospective. Do not implement or write tests in this first turn; wait for user follow-up. If paused for review or approval, remain paused until it is resolved. Later continuation permits at most one reviewable increment, not the whole task.`;

async function readIssue(pi: ExtensionAPI, ctx: ExtensionContext, id: string) {
	const result = await pi.exec("bd", ["show", `--id=${id}`, "--json", "--readonly"], {
		cwd: ctx.cwd,
		timeout: 10_000,
	});
	if (result.killed || result.code !== 0) {
		throw new Error(result.stderr.trim() || "Beads task lookup failed or timed out");
	}
	const issues: unknown = JSON.parse(result.stdout);
	const issue: unknown = Array.isArray(issues) && issues.length === 1 ? issues[0] : undefined;
	if (!Check(Issue, issue) || issue.id !== id) throw new Error(`Expected Beads task ${id}`);
	return issue;
}

async function readPrompt(pi: ExtensionAPI, name: string) {
	const path = pi.getCommands().find((command) => command.source === "prompt" && command.name === name)
		?.sourceInfo.path;
	if (!path) throw new Error(`Missing /${name} prompt template`);
	return stripFrontmatter(await readFile(path, "utf8"));
}

export default function checkpointExtension(pi: ExtensionAPI) {
	let running = false;
	let shutdown = false;
	let extraction: AbortController | undefined;

	pi.on("session_shutdown", () => {
		shutdown = true;
		extraction?.abort();
	});

	pi.registerCommand("checkpoint", {
		description: "Carry the current session's checkpoint into a fresh session: /checkpoint [steering]",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Checkpoint requires interactive mode.", "error");
				return;
			}
			if (running || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Finish or cancel the current operation before checkpointing.", "warning");
				return;
			}

			running = true;
			try {
				const entry = ctx.sessionManager
					.getBranch()
					.findLast((item) => item.type === "custom" && item.customType === "task-workflow");
				const candidate: unknown = entry?.type === "custom" ? entry.data : undefined;
				const workflow: typeof candidate = Check(Workflow, candidate) && candidate.cwd === ctx.cwd
					? candidate
					: undefined;
				const model = ctx.model;
				if (!model) throw new Error("Select a model before checkpointing.");
				const parentSession = ctx.sessionManager.getSessionFile();
				if (!parentSession)
					throw new Error("Checkpoint requires a saved session so the original remains recoverable.");
				const leaf = ctx.sessionManager.getLeafId();
				const issue = workflow ? await readIssue(pi, ctx, workflow.taskId) : undefined;
				if (issue?.status === "closed") throw new Error("The bound task is closed; no continuation was started.");
				const implementationPrompt = workflow
					? (await readPrompt(pi, workflow.mode))
						.replaceAll(`\${VCS_LOG}`, VCS_LOG_INSTRUCTIONS[workflow.vcs])
						.replaceAll("$1", workflow.taskId)
						.replaceAll("$ARGUMENTS", workflow.taskId)
					: undefined;
				const restorePrompt = (issue ? RESTORE_TASK_PROMPT : RESTORE_SESSION_PROMPT)
					.replaceAll("$1", () => workflow?.taskId ?? "")
					.replaceAll("$STEERING", () => args.trim() || "None");
				const vcs = workflow?.vcs ?? "git";
				const status = await pi.exec(
					vcs,
					vcs === "git" ? ["status", "--short", "--branch"] : ["status"],
					{ cwd: ctx.cwd, timeout: 10_000 },
				);
				if (status.killed || status.code !== 0)
					throw new Error(status.stderr.trim() || "Cannot inspect working-copy state");
				// Preserve the discussion, not potentially huge tool outputs or system/tool declarations.
				const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages.flatMap(
					(message): ReturnType<typeof buildSessionContext>["messages"] => {
						switch (message.role) {
							case "assistant": {
								const content = message.content.filter((part) => part.type === "text");
								return content.length ? [{ ...message, content }] : [];
							}
							case "user":
							case "custom":
							case "compactionSummary":
							case "branchSummary":
								return [message];
							default:
								return [];
						}
					},
				);
				const conversation = serializeConversation(convertToLlm(messages));
				if (conversation.length > model.contextWindow * 2) {
					throw new Error("Discussion exceeds the model's safe checkpoint budget. Compact or checkpoint earlier.");
				}
				extraction = new AbortController();
				const abort = extraction;
				const result = await ctx.ui.custom<string | Error | null>((tui, theme, _keys, done) => {
					const loader = new BorderedLoader(tui, theme, "Checkpointing session...");
					loader.onAbort = () => {
						abort.abort();
						done(null);
					};
					const stream = ctx.modelRegistry.streamSimple(
						model,
						{
							systemPrompt: CHECKPOINT_PROMPT,
							messages: [
								{
									role: "user",
									content: `${issue ? `Bound workflow: ${workflow!.mode}\n\nTask:\n${JSON.stringify(issue)}\n\n` : "No task is bound; checkpoint the existing session only.\n\n"}Working-copy status (observed now, not test verification):\n${status.stdout}\n\n${workflow ? `Workflow instructions:\n${workflow.prompt}\n\n` : ""}Available conversation:\n${conversation}\n\nCheckpoint steering:\n${args.trim() || "None"}`,
									timestamp: Date.now(),
								},
							],
						},
						{ signal: abort.signal, reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel },
					);
					stream
						.result()
						.then((response) => {
							if (abort.signal.aborted) return;
							if (response.stopReason !== "stop") {
								done(new Error(response.errorMessage || `Extraction stopped: ${response.stopReason}`));
								return;
							}
							done(
								response.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n"),
							);
						})
						.catch((error: unknown) => {
							if (!abort.signal.aborted) done(error instanceof Error ? error : new Error(String(error)));
						});
					return loader;
				});
				if (result === null || shutdown) return;
				if (result instanceof Error) throw result;
				const draft: unknown = JSON.parse(result);
				if (
					!Check(Checkpoint, draft) ||
					!draft.checkpoint.trim() ||
					!draft.reason.trim() ||
					!draft.testScope.trim()
				) {
					throw new Error("Invalid checkpoint extraction; the original session is unchanged.");
				}
				if (/^#{1,2}\s/m.test(draft.checkpoint)) throw new Error("Checkpoint body must use ### subheadings.");
				if (ctx.sessionManager.getLeafId() !== leaf || !ctx.isIdle() || ctx.hasPendingMessages()) {
					throw new Error("Session changed during extraction; checkpoint again from the current state.");
				}
				if (workflow) {
					const current = await readIssue(pi, ctx, workflow.taskId);
					if (JSON.stringify(current) !== JSON.stringify(issue)) {
						throw new Error("Task changed during extraction; no replacement was started. Retry to reconcile it.");
					}
				}
				const blocked = issue !== undefined && !["open", "in_progress"].includes(issue.status);
				const pause = draft.pause || blocked;
				const reason = blocked ? `Task status is ${issue.status}. ${draft.reason}` : draft.reason;
				const gate = `Workflow: ${workflow?.mode ?? "session-only"}\nTests: ${draft.tests}\nTest scope: ${draft.testScope}\nContinuation: ${pause ? "paused" : "one increment"}\nReason: ${reason}`;
				const section = `## Continuation checkpoint\n\n${draft.checkpoint.trim()}\n\n### Workflow state\n${gate}\n\nSource session: ${parentSession}\n`;
				const kickoff = `${implementationPrompt ?? "Continue the session's existing work using the conversation and checkpoint below; there is no Beads task."}\n\n## Restore the saved session\n${restorePrompt}\n\n## Handoff boundaries\nThis is a continuation, not a new task or a new first increment. Read the checkpoint carried in this session and inspect relevant working-tree state before acting. Preserve settled decisions and distinguish recorded verification from checks run now. ${workflow ? `Follow the selected ${workflow.mode} role and response style above.` : "Use the existing session as the only source of scope; do not invent task context."} The reset authorizes at most one later increment, not completion of the task. Do not infer design or test approval from the reset or from a request to continue.\n\n${gate}\n\nFirst reply with a brief state summary and proposed next action, then wait for user follow-up. Do not implement or write tests in this first turn.\n\n${pause ? "Remain paused until the outstanding review, approval, or blocker is resolved. Do not implement merely because context has been restored." : "On user follow-up, proceed with just the next permitted increment, then pause for review."}`;
				const name = issue ? `${issue.title.replace(/\s+/g, " ").trim()} — ${issue.id}` : undefined;
				if (shutdown) return;
				if (ctx.sessionManager.getLeafId() !== leaf || !ctx.isIdle() || ctx.hasPendingMessages()) {
					throw new Error("Session changed before replacement; no replacement was started.");
				}
				const switched = await ctx.newSession({
					parentSession,
					setup: async (session) => {
						if (workflow && implementationPrompt)
							session.appendCustomEntry("task-workflow", { ...workflow, prompt: implementationPrompt });
						if (name) session.appendSessionInfo(name);
						session.appendCustomMessageEntry("task-checkpoint", section, true);
					},
					withSession: async (replacement) => {
						try {
							await replacement.sendUserMessage(kickoff);
						} catch (error) {
							replacement.ui.setEditorText(kickoff);
							replacement.ui.notify(
								`Checkpoint restored; continuation failed: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						}
					},
				});
				if (switched.cancelled) ctx.ui.notify("Session replacement cancelled; original session unchanged.", "info");
			} catch (error) {
				if (!shutdown)
					ctx.ui.notify(`Checkpoint stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				extraction = undefined;
				running = false;
			}
		},
	});
}
