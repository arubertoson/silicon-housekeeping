import { KeybindingsManager, TUI_KEYBINDINGS, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptEditor } from "../extensions/prompt-editor.ts";

const plain = (text: string) => text;
const theme: EditorTheme = {
	borderColor: plain,
	selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

function editor() {
	// Input and autocomplete are real; only the terminal renderer is omitted.
	const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } } as unknown as TUI;
	const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape" } });
	const target = new PromptEditor(tui, theme, keybindings as ConstructorParameters<typeof PromptEditor>[2]);
	const cancel = vi.fn();
	const undo = vi.fn();
	target.onEscape = cancel;
	target.onDoubleEscape = undo;
	return { target, cancel, undo };
}

afterEach(() => vi.restoreAllMocks());

describe("prompt editor double Escape", () => {
	it("keeps single Escape cancellation and invokes undo once for a quick second press", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1000);
		const { target, cancel, undo } = editor();
		target.handleInput("\x1b");
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(undo).not.toHaveBeenCalled();
		now.mockReturnValue(1200);
		target.handleInput("\x1b");
		expect(undo).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(1);
		target.handleInput("\x1b");
		expect(undo).toHaveBeenCalledTimes(1);
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	it("does not treat presses 500ms apart as double Escape", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1000);
		const { target, cancel, undo } = editor();
		target.handleInput("\x1b");
		now.mockReturnValue(1500);
		target.handleInput("\x1b");
		expect(undo).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	it.each(["draft", " ", "!"])("never invokes undo while the editor contains %j", (draft) => {
		const { target, undo } = editor();
		target.setText(draft);
		target.handleInput("\x1b");
		target.handleInput("\x1b");
		expect(undo).not.toHaveBeenCalled();
		expect(target.getText()).toBe(draft);
	});

	it("resets the sequence on other input even if that input leaves the editor empty", () => {
		const { target, undo } = editor();
		target.handleInput("\x1b");
		target.handleInput("\x1b[D");
		target.handleInput("\x1b");
		expect(undo).not.toHaveBeenCalled();
	});

	it("ignores Escape repeats and releases rather than interpreting a held key as two presses", () => {
		const { target, cancel, undo } = editor();
		target.handleInput("\x1b");
		target.handleInput("\x1b[27;1:2u");
		target.handleInput("\x1b[27;1:3u");
		expect(undo).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledTimes(1);
		target.handleInput("\x1b");
		expect(undo).toHaveBeenCalledTimes(1);
	});

	it("does not count Escape used to dismiss autocomplete", async () => {
		const { target, undo } = editor();
		target.setAutocompleteProvider({
			getSuggestions: () => ({ items: [{ value: "/undo", label: "/undo" }, { value: "/tree", label: "/tree" }], prefix: "" }),
			applyCompletion: () => ({ lines: ["/undo"], cursorLine: 0, cursorCol: 5 }),
		});
		target.handleInput("\t");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(target.isShowingAutocomplete()).toBe(true);
		target.handleInput("\x1b");
		expect(target.isShowingAutocomplete()).toBe(false);
		target.handleInput("\x1b");
		expect(undo).not.toHaveBeenCalled();
	});
});
