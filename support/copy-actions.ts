import { copyToClipboard, type ExtensionCommandContext, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { extractCopyBlocks } from "./copy-blocks.ts";
import { openCopyEditor } from "./copy-editor.ts";
import { pickCopyItem, type CopyItem } from "./copy-picker.ts";
import { branchMessages, formatBody, formatRange, singleLine } from "./copy-transcript.ts";

type Message = SessionMessageEntry["message"];

function messageText(message: Message): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function lastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	// Use Pi 1.4's last-message rule, including its empty-abort exception.
	// Retain source whitespace for block extraction; bare copy trims at its boundary.
	const messages = ctx.sessionManager.buildSessionContext().messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "aborted" && message.content.length === 0) continue;
		const text = messageText(message);
		return text.trim() ? text : undefined;
	}
	return undefined;
}

function preview(text: string): string {
	const firstLine = stripTerminalSequences(text).split("\n").find((line) => line.trim()) ?? "";
	return singleLine(firstLine).slice(0, 180);
}

async function copy(ctx: ExtensionCommandContext, text: string, subject: string, success: string): Promise<void> {
	try {
		await copyToClipboard(text);
	} catch (error) {
		ctx.ui.notify(`Could not copy ${subject}: ${singleLine(error instanceof Error ? error.message : String(error))}`, "error");
		return;
	}
	ctx.ui.notify(success, "info");
}

export async function copyLastAssistant(ctx: ExtensionCommandContext): Promise<void> {
	// The TUI handles bare /copy itself. Keep this fallback equivalent for direct callers.
	const text = lastAssistantText(ctx);
	if (!text) {
		ctx.ui.notify("No agent messages to copy yet.", "warning");
		return;
	}
	await copy(ctx, text.trim(), "message", "Copied last agent message to clipboard");
}

export async function editLastAssistant(ctx: ExtensionCommandContext, configuredEditor?: string): Promise<void> {
	const text = lastAssistantText(ctx);
	if (!text) {
		ctx.ui.notify("No assistant text to open in an editor", "warning");
		return;
	}
	try {
		await openCopyEditor(ctx, text, configuredEditor);
	} catch (error) {
		ctx.ui.notify(`Could not open response in editor: ${singleLine(error instanceof Error ? error.message : String(error))}`, "error");
	}
}

export async function copyMessage(ctx: ExtensionCommandContext): Promise<void> {
	// Snapshot raw recorded text on this branch, not rewritten or compacted context.
	const messages = branchMessages(ctx.sessionManager.getBranch()).reverse().flatMap((entry) => {
		if (entry.message.role !== "user" && entry.message.role !== "assistant") return [];
		const content = messageText(entry.message);
		return content.trim() ? [{ ...entry, content }] : [];
	});
	if (!messages.length) {
		ctx.ui.notify("No user or assistant text on the active branch to copy", "warning");
		return;
	}
	const items = messages.map((entry): CopyItem => {
		const label = singleLine(`${entry.message.role} [${entry.id}] ${entry.timestamp}`);
		return { value: entry.id, label, description: preview(entry.content), searchText: `${label} ${entry.content}`.toLowerCase() };
	});
	const selected = await pickCopyItem(ctx, "Copy message — active branch (newest first)", items, "No matching messages");
	if (selected === undefined) return;
	const entry = messages.find((entry) => entry.id === selected);
	if (entry) await copy(ctx, entry.content, "message", "Copied message to clipboard");
}

export async function copyRange(ctx: ExtensionCommandContext): Promise<void> {
	// Never use getEntries() (other branches) or buildSessionContext() (rewritten history).
	const messages = branchMessages(ctx.sessionManager.getBranch());
	if (!messages.length) {
		ctx.ui.notify("No messages on the active branch to copy", "warning");
		return;
	}
	const items = messages.map((entry, index): CopyItem => {
		const body = formatBody(entry.message);
		const label = singleLine(`#${index + 1} ${entry.message.role} [${entry.id}] ${entry.timestamp}`);
		return {
			value: String(index), label,
			description: preview(body.replace(/^`{3,}[^\n]*\n?/gm, "")),
			searchText: `${label} ${body}`.toLowerCase(),
		};
	});
	const startValue = await pickCopyItem(ctx, "Copy range — choose START (active branch)", items, "No matching messages");
	if (startValue === undefined) return;
	const start = Number(startValue);
	// Default to one message; the end cannot precede the start.
	const endValue = await pickCopyItem(ctx, `Copy range — choose END (inclusive, from #${start + 1})`, items.slice(start), "No matching messages");
	if (endValue === undefined) return;
	const end = Number(endValue);
	const count = end - start + 1;
	await copy(ctx, formatRange(messages, start, end), "range", `Copied ${count} ${count === 1 ? "message" : "messages"} (#${start + 1}–#${end + 1}) to clipboard`);
}

export async function copyBlock(ctx: ExtensionCommandContext): Promise<void> {
	const text = lastAssistantText(ctx);
	if (!text) {
		ctx.ui.notify("No assistant text to copy blocks from", "warning");
		return;
	}
	const blocks = extractCopyBlocks(text);
	if (!blocks.length) {
		ctx.ui.notify("No fenced code blocks or blockquotes in the last assistant message", "warning");
		return;
	}
	let index = 0;
	if (blocks.length > 1) {
		const items = blocks.map((block, index): CopyItem => {
			const label = block.kind === "quote" ? "Quote" : singleLine(block.language || "Code");
			const metadata = `${block.kind} ${label} line ${block.line} ${block.content.split("\n").length} lines`;
			return { value: String(index), label, description: preview(block.content), searchText: `${metadata} ${block.content}`.toLowerCase() };
		});
		const selected = await pickCopyItem(ctx, "Copy block", items, "No matching blocks", "compact");
		if (selected === undefined) return;
		index = Number(selected);
	}
	await copy(ctx, blocks[index].content, "block", "Copied block to clipboard");
}
