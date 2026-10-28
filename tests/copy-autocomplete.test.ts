import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import copyExtension from "../extensions/copy.ts";
import { copyAutocomplete } from "../support/copy-autocomplete.ts";

const options = { signal: new AbortController().signal };

function provider() {
	const base = new CombinedAutocompleteProvider([{ name: "copy", description: "Built-in copy" }, { name: "model" }], process.cwd());
	const current: AutocompleteProvider = {
		triggerCharacters: [";"],
		getSuggestions: vi.fn(base.getSuggestions.bind(base)),
		applyCompletion: vi.fn(base.applyCompletion.bind(base)),
		shouldTriggerFileCompletion: vi.fn(base.shouldTriggerFileCompletion.bind(base)),
	};
	return { current, wrapped: copyAutocomplete(current) };
}

describe("copy autocomplete", () => {
	it.each([false, true])("offers all subcommands after a space (forced=%s)", async (force) => {
		const { wrapped, current } = provider();
		const result = await wrapped.getSuggestions(["/copy "], 0, 6, { ...options, force });
		expect(result?.prefix).toBe("");
		expect(result?.items.map((item) => item.value)).toEqual(["message", "range", "block", "edit"]);
		expect(current.getSuggestions).not.toHaveBeenCalled();
		expect(wrapped.shouldTriggerFileCompletion?.(["/copy "], 0, 6)).toBe(false);
	});

	it("filters and inserts a subcommand through the existing provider", async () => {
		const { wrapped } = provider();
		const input = "/copy b";
		const result = await wrapped.getSuggestions([input], 0, input.length, options);
		expect(result?.items.map((item) => item.value)).toEqual(["block"]);
		if (!result) throw new Error("Missing suggestions");
		const completion = wrapped.applyCompletion([input], 0, input.length, result.items[0], result.prefix);
		expect(completion).toEqual({ lines: ["/copy block"], cursorLine: 0, cursorCol: 11 });
	});

	it("preserves text after the cursor when inserting a completion", async () => {
		const { wrapped } = provider();
		const input = "/copy m suffix";
		const result = await wrapped.getSuggestions([input], 0, 7, options);
		if (!result) throw new Error("Missing suggestions");
		expect(wrapped.applyCompletion([input], 0, 7, result.items[0], result.prefix).lines).toEqual(["/copy message suffix"]);
	});

	it("does not fall back to file suggestions for an unknown copy subcommand", async () => {
		const { wrapped, current } = provider();
		expect(await wrapped.getSuggestions(["/copy nope"], 0, 10, options)).toEqual({ prefix: "nope", items: [] });
		expect(current.getSuggestions).not.toHaveBeenCalled();
	});

	it.each(["/copy", "/cop", "/model ", "/copy block extra", "text /copy b", ";snippet"])("delegates unrelated input %j", async (input) => {
		const { wrapped, current } = provider();
		await wrapped.getSuggestions([input], 0, input.length, options);
		expect(current.getSuggestions).toHaveBeenCalledWith([input], 0, input.length, options);
		wrapped.shouldTriggerFileCompletion?.([input], 0, input.length);
		expect(current.shouldTriggerFileCompletion).toHaveBeenCalled();
		expect(wrapped.triggerCharacters).toEqual([";"]);
	});

	it("does not complete commands inside multiline input", async () => {
		const { wrapped, current } = provider();
		await wrapped.getSuggestions(["/copy b", "other input"], 0, 7, options);
		expect(current.getSuggestions).toHaveBeenCalled();
	});

	it("registers its provider only for a TUI session", () => {
		let start: (event: unknown, ctx: ExtensionContext) => void = () => { throw new Error("Missing session handler"); };
		const registerCommand = vi.fn();
		copyExtension({
			registerCommand,
			on(event: string, handler: typeof start) {
				expect(event).toBe("session_start");
				start = handler;
			},
		} as unknown as ExtensionAPI);
		const addAutocompleteProvider = vi.fn();
		const ui = { addAutocompleteProvider } as unknown as ExtensionUIContext;
		for (const mode of ["rpc", "print", "json"] as const) start({}, { mode, ui } as ExtensionContext);
		expect(addAutocompleteProvider).not.toHaveBeenCalled();
		start({}, { mode: "tui", ui } as ExtensionContext);
		expect(addAutocompleteProvider).toHaveBeenCalledExactlyOnceWith(copyAutocomplete);
		expect(registerCommand).toHaveBeenCalledExactlyOnceWith("copy", expect.any(Object));
	});
});
