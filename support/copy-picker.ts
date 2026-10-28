import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type SelectItem } from "@earendil-works/pi-tui";

export interface CopyItem extends SelectItem {
	searchText: string;
}

export function pickCopyItem(
	ctx: ExtensionCommandContext,
	title: string,
	choices: readonly CopyItem[],
	noMatch: string,
	presentation: "search" | "compact" = "search",
): Promise<string | undefined> {
	const compact = presentation === "compact";
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
		const container = new Container();
		const heading = theme.fg("accent", title) + (compact ? theme.fg("dim", " · esc to cancel") : "");
		container.addChild(new Text(heading, 0, 0));
		const input = compact ? undefined : new Input({ prompt: "Search: " });
		if (input) container.addChild(input);
		if (compact) container.addChild(new Spacer(1));
		const numberWidth = String(choices.length).length;
		const items = choices.map((item, index) => compact
			? { ...item, label: `${String(index + 1).padStart(numberWidth)}   ${item.label}` }
			: item);
		let renderWidth = 0;
		const list = new SelectList(items, 10, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => {
				const line = compact ? text.replace(/^→ /, "▸ ") : text;
				return theme.bg("selectedBg", theme.fg("text", line + " ".repeat(Math.max(0, renderWidth - visibleWidth(line)))));
			},
			description: (text) => theme.fg("text", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: () => theme.fg("warning", noMatch),
		}, {
			minPrimaryColumnWidth: 8,
			maxPrimaryColumnWidth: 32,
			truncatePrimary: ({ text, maxWidth }) => theme.fg("muted", truncateToWidth(text, maxWidth)),
		});
		container.addChild(list);
		const status = new Text("", 0, 0);
		if (!compact) {
			container.addChild(status);
			container.addChild(new Text(theme.fg("dim", "Type to select • ↑↓ / ctrl+n/p move • enter confirm • esc cancel"), 0, 0));
		}
		let canConfirm = choices.length > 0;
		list.onSelect = (item) => { if (canConfirm) done(item.value); };
		list.onCancel = () => done(undefined);
		const updateSelection = () => {
			if (!input) return;
			const terms = input.getValue().toLowerCase().trim().split(/\s+/).filter(Boolean);
			const index = items.findIndex((item) => terms.every((term) => item.searchText.includes(term)));
			canConfirm = index >= 0;
			status.setText(canConfirm ? "" : theme.fg("warning", noMatch));
			if (canConfirm) list.setSelectedIndex(index);
		};
		const moveSelection = (direction: number) => {
			if (!choices.length) return;
			const selected = list.getSelectedItem();
			const index = items.findIndex((item) => item === selected);
			list.setSelectedIndex((index + direction + choices.length) % choices.length);
			// Explicit navigation can confirm a visible option even after a failed search.
			canConfirm = true;
			status.setText("");
		};
		let focused = false;
		return {
			get focused() { return focused; },
			set focused(value: boolean) {
				focused = value;
				if (input) input.focused = value;
			},
			render(width: number) {
				renderWidth = compact ? Math.max(1, width - 4) : width;
				const lines = container.render(renderWidth);
				// Pi already supplies the blank line above the editor/dialog slot.
				const padded = compact ? [...lines.map((line) => `  ${line}`), ""] : lines;
				return padded.map((line) => truncateToWidth(line, width));
			},
			invalidate() { container.invalidate(); },
			handleInput(data: string) {
				if (matchesKey(data, "ctrl+n")) {
					moveSelection(1);
				} else if (matchesKey(data, "ctrl+p")) {
					moveSelection(-1);
				} else if (keys.matches(data, "tui.select.up")) {
					moveSelection(-1);
				} else if (keys.matches(data, "tui.select.down")) {
					moveSelection(1);
				} else if (keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.select.cancel")) {
					list.handleInput(data);
				} else if (input) {
					const before = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== before) updateSelection();
				}
				tui.requestRender();
			},
		} satisfies Component & Focusable;
	});
}
