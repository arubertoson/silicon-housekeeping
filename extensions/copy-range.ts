import { copyToClipboard, type ExtensionAPI, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, truncateToWidth, type Component, type Focusable, type SelectItem } from "@earendil-works/pi-tui";

interface CopyMessage {
	id: string;
	timestamp: string;
	message: SessionMessageEntry["message"];
}

interface MessageItem extends SelectItem {
	searchText: string;
}

export default function copyRangeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("copy-range", {
		description: "Copy an inclusive message range from the active branch, including tools",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /copy-range — choose start and end messages", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/copy-range requires TUI mode for its searchable message picker", "error");
				return;
			}

			// Snapshot raw root-to-leaf history, including pre-compaction messages.
			// Never use getEntries() (other branches) or buildSessionContext() (rewritten history).
			const messages = branchMessages(ctx.sessionManager.getBranch());
			if (!messages.length) {
				ctx.ui.notify("No messages on the active branch to copy", "warning");
				return;
			}
			const items = messages.map((entry, index): MessageItem => {
				const body = formatBody(entry.message);
				const label = singleLine(`#${index + 1} ${entry.message.role} [${entry.id}] ${entry.timestamp}`);
				return {
					value: String(index), label,
					description: singleLine(body.replace(/^`{3,}[^\n]*\n?/gm, "")).slice(0, 180),
					searchText: `${label} ${body}`.toLowerCase(),
				};
			});
			const pick = (title: string, choices: MessageItem[]) => ctx.ui.custom<number | undefined>((tui, theme, keys, done) => {
				const container = new Container();
				container.addChild(new Text(title, 0, 0));
				const input = new Input({ prompt: "Search: " });
				container.addChild(input);
				const listContainer = new Container();
				container.addChild(listContainer);
				container.addChild(new Text("Type to search text, roles, tools or IDs • ↑↓ select • enter confirm • esc cancel", 0, 0));
				let list: SelectList;
				const updateList = () => {
					const terms = input.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
					const filtered = choices.filter((item) => terms.every((term) => item.searchText.includes(term)));
					list = new SelectList(filtered, 10, {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: () => theme.fg("warning", "No matching messages"),
					});
					list.onSelect = (item) => done(Number(item.value));
					list.onCancel = () => done(undefined);
					listContainer.clear();
					listContainer.addChild(list);
				};
				updateList();
				return {
					get focused() { return input.focused; },
					set focused(value: boolean) { input.focused = value; },
					render(width: number) {
						return container.render(width).map((line) => truncateToWidth(line, width));
					},
					invalidate() { container.invalidate(); },
					handleInput(data: string) {
						if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const)
							.some((action) => keys.matches(data, action))) {
							list.handleInput(data);
						} else {
							const before = input.getValue();
							input.handleInput(data);
							if (input.getValue() !== before) updateList();
						}
						tui.requestRender();
					},
				} satisfies Component & Focusable;
			});

			const start = await pick("Copy range — choose START (active branch)", items);
			if (start === undefined) return;
			// Default to a single message, not the remainder or the entire session.
			const end = await pick(`Copy range — choose END (inclusive, from #${start + 1})`, items.slice(start));
			if (end === undefined) return;
			try {
				await copyToClipboard(formatRange(messages, start, end));
			} catch (error) {
				ctx.ui.notify(`Could not copy range: ${singleLine(error instanceof Error ? error.message : String(error))}`, "error");
				return;
			}
			const count = end - start + 1;
			ctx.ui.notify(`Copied ${count} ${count === 1 ? "message" : "messages"} (#${start + 1}–#${end + 1}) to clipboard`, "info");
		},
	});
}

function branchMessages(branch: readonly SessionEntry[]): CopyMessage[] {
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
function singleLine(text: string): string {
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

function formatBody(message: CopyMessage["message"]): string {
	const { role: _role, timestamp: _timestamp, ...fields } = message;
	if (message.role === "bashExecution") {
		const { command, output, ...metadata } = fields as Omit<typeof message, "role" | "timestamp">;
		return `Command:\n${fenced(command, "sh")}\n\nOutput:\n${fenced(output)}\n\nMetadata:\n${json(metadata)}`;
	}
	const { content, summary, ...metadata } = fields as Record<string, unknown>;
	const body = formatContent(content ?? summary);
	return [body, Object.keys(metadata).length ? `Metadata:\n${json(metadata)}` : ""].filter(Boolean).join("\n\n") || "[Empty message]";
}

function formatRange(messages: CopyMessage[], start: number, end: number): string {
	return [
		`# Pi transcript — active branch, messages #${start + 1}–#${end + 1} (inclusive)`,
		"Raw recorded history; image data and opaque content signatures omitted. Tool output is not truncated by this export.",
		...messages.slice(start, end + 1).map((entry, offset) =>
			`## #${start + offset + 1} ${singleLine(entry.message.role)} [${singleLine(entry.id)}] — ${singleLine(entry.timestamp)}\n\n${formatBody(entry.message)}`),
	].join("\n\n") + "\n";
}
