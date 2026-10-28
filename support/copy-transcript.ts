import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export interface CopyMessage {
	id: string;
	timestamp: string;
	message: SessionMessageEntry["message"];
}

export function branchMessages(branch: readonly SessionEntry[]): CopyMessage[] {
	return branch.flatMap((entry): CopyMessage[] => {
		let message: CopyMessage["message"];
		switch (entry.type) {
			case "message": message = entry.message; break;
			case "custom_message":
				message = { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, timestamp: Date.parse(entry.timestamp) };
				break;
			case "compaction":
				message = { role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: Date.parse(entry.timestamp) };
				break;
			case "branch_summary":
				message = { role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: Date.parse(entry.timestamp) };
				break;
			default: return [];
		}
		return [{ id: entry.id, timestamp: entry.timestamp, message }];
	});
}

// Keep terminal escape sequences and control characters out of labels/notifications.
export function singleLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function fenced(text: string, language = "text"): string {
	// Tool output can itself contain Markdown fences; never let it close ours.
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${language}\n${text}\n${fence}`;
}

function json(value: unknown): string {
	return fenced(JSON.stringify(value, null, 2) ?? "null", "json");
}

function formatContent(content: unknown): string {
	if (typeof content === "string") return fenced(content);
	if (!Array.isArray(content)) return content === undefined ? "" : json(content);
	return content.map((block) => {
		switch (block.type) {
			case "text": return fenced(block.text);
			case "thinking": return `Thinking${block.redacted ? " (redacted)" : ""}:\n${fenced(block.thinking ?? "")}`;
			case "toolCall":
				return `Tool call: ${singleLine(block.namespace ? `${block.namespace}.${block.name}` : block.name)} [${singleLine(block.id)}]\n${json(block.arguments)}`;
			case "image": return `[Image: ${singleLine(block.mimeType)}; base64 data omitted]`;
			default: return json(block);
		}
	}).join("\n\n");
}

export function formatBody(message: CopyMessage["message"]): string {
	const { role: _role, timestamp: _timestamp, ...fields } = message;
	if (message.role === "bashExecution") {
		const { command, output, ...metadata } = fields as Omit<typeof message, "role" | "timestamp">;
		return `Command:\n${fenced(command, "sh")}\n\nOutput:\n${fenced(output)}\n\nMetadata:\n${json(metadata)}`;
	}
	const { content, summary, ...metadata } = fields as Record<string, unknown>;
	const body = formatContent(content ?? summary);
	return [body, Object.keys(metadata).length ? `Metadata:\n${json(metadata)}` : ""].filter(Boolean).join("\n\n") || "[Empty message]";
}

export function formatRange(messages: readonly CopyMessage[], start: number, end: number): string {
	return [
		`# Pi transcript — active branch, messages #${start + 1}–#${end + 1} (inclusive)`,
		"Raw recorded history; image data and opaque content signatures omitted. Tool output is not truncated by this export.",
		...messages.slice(start, end + 1).map((entry, offset) =>
			`## #${start + offset + 1} ${singleLine(entry.message.role)} [${singleLine(entry.id)}] — ${singleLine(entry.timestamp)}\n\n${formatBody(entry.message)}`),
	].join("\n\n") + "\n";
}
