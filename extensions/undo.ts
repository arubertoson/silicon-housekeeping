import type {
	ExtensionAPI, ExtensionCommandContext, SessionEntry, SessionHeader, SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type UserEntry = SessionMessageEntry & { message: Extract<SessionMessageEntry["message"], { role: "user" }> };
type Snapshot = { header: SessionHeader; entries: SessionEntry[] };
type UndoMessage = UserEntry["message"] & { siliconUndoPrompt?: string; siliconUndoParentId?: string | null };
type Submission = { text: string; parentId: string | null };
type SessionView = ExtensionCommandContext["sessionManager"];

function snapshot(manager: SessionView): Snapshot {
	const header = manager.getHeader();
	if (!header) throw new Error("Session has no header");
	// Compare/persist the JSON representation; Pi keeps optional undefined fields
	// in memory which disappear on disk.
	return JSON.parse(JSON.stringify({ header, entries: manager.getEntries() })) as Snapshot;
}

function serialize(state: Snapshot): string {
	return [state.header, ...state.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function readSnapshot(path: string): Snapshot {
	// Unlike Pi's forgiving reader, never silently discard malformed records during deletion.
	const [header, ...entries] = readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
	if (header?.type !== "session" || header.version !== 3 || entries.some((entry) => entry.type === "session")) {
		throw new Error("Undo requires a valid v3 session file");
	}
	return { header, entries };
}

function replaceFile(path: string, state: Snapshot): void {
	const temporary = `${path}.undo-${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeFileSync(fd, serialize(state));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

function latestUser(manager: SessionView): UserEntry | undefined {
	return manager.getBranch().findLast((entry): entry is UserEntry => entry.type === "message" && entry.message.role === "user");
}

function references(entry: SessionEntry): (string | null)[] {
	const result = [entry.parentId];
	if (entry.type === "label" || entry.type === "context_edit") result.push(entry.targetId);
	if (entry.type === "branch_summary") result.push(entry.fromId);
	if (entry.type === "compaction") result.push(entry.firstKeptEntryId);
	return result;
}

function removeTurn(state: Snapshot, target: UserEntry): Snapshot {
	// New submissions record the position before Pi inserts prompt updates or
	// automatic compaction. Older turns fall back to the user's immediate parent.
	const recorded = (target.message as UndoMessage).siliconUndoParentId;
	const parentId = recorded === undefined ? target.parentId : recorded;
	let first: SessionEntry = target;
	const visited = new Set<string>();
	while (first.parentId !== parentId) {
		if (visited.has(first.id)) throw new Error("Invalid undo boundary");
		visited.add(first.id);
		const parent = state.entries.find((entry) => entry.id === first.parentId);
		if (!parent) throw new Error("The recorded undo boundary is not an ancestor of this turn");
		first = parent;
	}
	// Remove descendants on every branch, and summaries/edits/bookmarks referring to them.
	const removed = new Set([first.id]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of state.entries) {
			if (!removed.has(entry.id) && references(entry).some((id) => id !== null && removed.has(id))) {
				removed.add(entry.id);
				changed = true;
			}
		}
	}
	const entries = state.entries.filter((entry) => !removed.has(entry.id));
	if (parentId === null) {
		if (entries.length) throw new Error("Cannot undo a root turn while unrelated roots remain");
	} else {
		const parent = entries.find((entry) => entry.id === parentId);
		if (!parent) throw new Error("The previous conversation state depends on the turn being removed");
		// JSONL has no persisted leaf pointer: Pi resumes at the last record. Move an
		// existing record, rather than adding a marker or duplicating it. Tree links,
		// timestamps and unrelated branches are unchanged.
		entries.splice(entries.indexOf(parent), 1);
		entries.push(parent);
	}
	return { header: state.header, entries };
}

function promptText(entry: UserEntry): string {
	const recorded = entry.message as UndoMessage;
	if (typeof recorded.siliconUndoPrompt === "string") return recorded.siliconUndoPrompt;
	return typeof recorded.content === "string" ? recorded.content : recorded.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function errorText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export default function undoExtension(pi: ExtensionAPI): void {
	let busy = false;
	let input: Submission | undefined;
	let submitted: Submission | undefined;
	// Store the unexpanded prompt on the existing user record, not in another
	// session entry. Resuming/reloading therefore also preserves /template input.
	pi.on("input", (event, ctx) => {
		if (!event.streamingBehavior) input = { text: event.text, parentId: ctx.sessionManager.getLeafId() };
	});
	pi.on("before_agent_start", () => {
		submitted = input;
		input = undefined;
	});
	pi.on("message_end", (event) => {
		if (event.message.role !== "user" || submitted === undefined) return;
		const { text, parentId } = submitted;
		submitted = undefined;
		return { message: { ...event.message, siliconUndoPrompt: text, siliconUndoParentId: parentId } as UndoMessage };
	});

	pi.registerShortcut("alt+u", {
		description: "Undo the latest submitted turn",
		handler: () => {
			// Shortcuts lack command/session-switch controls. Dispatch /undo as a
			// command, not a literal user message, even while a response is active.
			pi.sendUserMessage("/undo", { expandPromptTemplates: true });
		},
	});

	pi.registerCommand("undo", {
		description: "Delete the latest user turn and restore its prompt (tool side effects are not undone)",
		handler: async (args, ctx) => {
			if (args.trim()) return ctx.ui.notify("Usage: /undo", "warning");
			if (busy) return ctx.ui.notify("Undo is already in progress", "warning");
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") return ctx.ui.notify("/undo requires an editor (TUI or RPC mode)", "warning");
			const path = ctx.sessionManager.getSessionFile();
			if (!path) return ctx.ui.notify("/undo requires a saved session; --no-session is not supported", "warning");
			if (submitted) return ctx.ui.notify("Prompt is still being prepared; retry /undo once its user turn appears", "warning");
			const target = latestUser(ctx.sessionManager);
			if (!target) return ctx.ui.notify("No user turn to undo", "info");
			if (Array.isArray(target.message.content) && target.message.content.some((block) => block.type !== "text")) {
				return ctx.ui.notify("Cannot undo an attachment turn: Pi cannot restore attachments to the editor", "warning");
			}
			if (ctx.hasPendingMessages()) return ctx.ui.notify("Retrieve queued prompts before /undo; they will not be discarded", "warning");
			if (ctx.ui.getEditorText()) return ctx.ui.notify("Save or clear the editor draft before /undo", "warning");

			busy = true;
			let lock: number | undefined;
			let original: Snapshot | undefined;
			let rewritten = false;
			let replacement: ExtensionCommandContext | undefined;
			try {
				lock = openSync(`${path}.undo.lock`, "wx", 0o600);
				ctx.abort();
				await ctx.waitForIdle(); // Aborted assistant/tool results must land before pruning.
				if (ctx.hasPendingMessages() || ctx.ui.getEditorText()) throw new Error("Queued prompts or editor text appeared while stopping; nothing was removed");
				if (latestUser(ctx.sessionManager)?.id !== target.id) throw new Error("The latest user turn changed while stopping; retry /undo");
				original = snapshot(ctx.sessionManager);
				if (!isDeepStrictEqual(readSnapshot(path), original)) throw new Error("Session file changed outside this runtime; reload before undoing");
				const restored = removeTurn(original, target);
				const text = promptText(target);
				replaceFile(path, restored);
				rewritten = true;
				const result = await ctx.switchSession(path, {
					withSession: async (fresh) => {
						replacement = fresh;
						// switchSession opens the file before outgoing session_shutdown.
						// Shutdown hooks may append to the OLD leaf on disk. The freshly
						// loaded manager is authoritative; remove those stray writes.
						let loaded = snapshot(fresh.sessionManager);
						// Pi bootstraps two settings records when resuming a session with
						// no context messages, even if those settings already exist. Undo
						// must not leave those new entries behind. The CLI currently exposes
						// a real SessionManager through its read-only context surface; use
						// its public reload method only for this empty-context case.
						const added = loaded.entries.slice(restored.entries.length);
						if (fresh.sessionManager.buildSessionProjection().messages.length === 0 &&
							added.length === 2 && added[0].type === "model_change" && added[1].type === "thinking_level_change") {
							if (!(fresh.sessionManager instanceof SessionManager)) throw new Error("This Pi runtime cannot reload an empty session without adding settings entries");
							replaceFile(path, restored);
							fresh.sessionManager.setSessionFile(path);
							loaded = snapshot(fresh.sessionManager);
						}
						const removed = new Set(original!.entries.filter((entry) => !restored.entries.some((kept) => kept.id === entry.id)).map((entry) => entry.id));
						if (loaded.entries.some((entry) => removed.has(entry.id) || references(entry).some((id) => id !== null && removed.has(id)))) {
							throw new Error("A session-switch hook wrote into the removed turn");
						}
						if (!isDeepStrictEqual(loaded, restored)) {
							throw new Error("Session-start hooks changed the history; undo cannot add or alter retained entries");
						}
						replaceFile(path, loaded);
						fresh.ui.setEditorText(text);
						fresh.ui.notify("Turn removed; prompt restored. Files and tool side effects were not undone.", "info");
					},
				});
				if (result.cancelled) {
					// The old context is valid only on cancellation. Include anything
					// that before-switch handlers appended to its in-memory manager.
					replaceFile(path, snapshot(ctx.sessionManager));
					rewritten = false;
					ctx.ui.notify("Undo cancelled; the turn was not removed", "info");
				}
			} catch (error) {
				let recovery = "";
				if (rewritten && original) {
					try { replaceFile(path, original); }
					catch (failure) { recovery = ` Could not restore the session file: ${errorText(failure)}`; }
				}
				// Replacement failures can invalidate ctx without reaching withSession.
				// Never hide the original failure behind a stale-context exception.
				const message = `Undo failed: ${errorText(error)}${recovery}${rewritten ? " Resume the saved session before continuing." : ""}`;
				try { (replacement ?? ctx).ui.notify(message, "error"); }
				catch { console.error(message); }
			} finally {
				if (lock !== undefined) {
					closeSync(lock);
					unlinkSync(`${path}.undo.lock`);
				}
				busy = false;
			}
		},
	});
}
