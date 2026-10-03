import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, getKeybindings, type AutocompleteProvider, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import snippetsExtension, { createSnippetAutocompleteProvider, parseSnippets } from "../extensions/snippets.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function agentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-snippets-"));
  roots.push(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  return root;
}

const options = { signal: new AbortController().signal };
const plain = (text: string) => text;
const theme: EditorTheme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};

function editor(): CustomEditor {
  // Only rendering is faked: input, completion, cursor movement, and undo are Pi's real editor.
  const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } } as unknown as TUI;
  const keybindings = getKeybindings() as unknown as ConstructorParameters<typeof CustomEditor>[2];
  return new CustomEditor(tui, theme, keybindings);
}

function extensionHarness(base: AutocompleteProvider, target?: CustomEditor) {
  let provider = base;
  let installations = 0;
  const warnings: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      notify(message: string) { warnings.push(message); },
      addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider) {
        provider = factory(provider);
        target?.setAutocompleteProvider(provider);
        installations++;
      },
    },
  };
  let start: ((event: unknown, context: typeof ctx) => Promise<void>) | undefined;
  snippetsExtension({
    on(event: string, handler: typeof start) {
      expect(event).toBe("session_start");
      start = handler;
    },
  } as unknown as ExtensionAPI);
  return {
    get provider() { return provider; },
    get installations() { return installations; },
    warnings,
    // Pi clears provider wrappers and supplies a fresh UI context on session rebind.
    rebind: async () => {
      provider = base;
      ctx.ui = { ...ctx.ui };
      await start!({}, ctx);
    },
    start: async (mode = "tui") => start!({}, { ...ctx, mode }),
  };
}

async function flushAutocomplete() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("editor snippets", () => {
  it("loads JSON and expands with Tab in a CustomEditor without submitting; undo restores the reference", async () => {
    const root = await agentDir();
    await writeFile(join(root, "snippets.json"), JSON.stringify({ careful: "Check edge cases." }));
    const target = editor();
    const submit = vi.fn();
    target.onSubmit = submit;
    const harness = extensionHarness(new CombinedAutocompleteProvider([], root, null), target);
    await harness.start();

    target.setText("Before ;careful after");
    for (let i = 0; i < " after".length; i++) target.handleInput("\x1b[D");
    target.handleInput("\t");
    await flushAutocomplete();
    expect(target.getText()).toBe("Before Check edge cases. after");
    expect(target.getCursor()).toEqual({ line: 0, col: "Before Check edge cases.".length });
    expect(submit).not.toHaveBeenCalled();

    target.handleInput("\x1b[45;5u"); // Ctrl+-: native undo.
    expect(target.getText()).toBe("Before ;careful after");
  });

  it("lists and filters case-sensitive names, preserving other completion triggers", async () => {
    const root = await agentDir();
    const base: AutocompleteProvider = new CombinedAutocompleteProvider([], root, null);
    base.triggerCharacters = ["$"];
    const provider = createSnippetAutocompleteProvider(base, () => parseSnippets(JSON.stringify({
      reviewer: "Longer name", review: "Line one\nLine two", Review: "Capitalized", tests: "Add tests",
    })));
    expect(provider.triggerCharacters).toEqual(["$", ";"]);
    const names = async (text: string) => (await provider.getSuggestions([text], 0, text.length, options))?.items.map((item) => item.value);
    expect(await names(";")).toEqual([";Review", ";review", ";reviewer", ";tests"]);
    expect(await names("Text ;rev")).toEqual([";review", ";reviewer"]);
    expect(await names(";Review")).toEqual([";Review"]);
    expect(await names(";unknown")).toEqual([]);
    expect((await provider.getSuggestions([";review"], 0, 7, options))?.items[0]?.description).toBe("Line one Line two");
    expect(provider.shouldTriggerFileCompletion?.([";rev"], 0, 4)).toBe(true);
    expect((await provider.getSuggestions([";review"], 0, 7, { ...options, force: true }))?.items.map((item) => item.value))
      .toEqual([";review"]);
  });

  it("uses native autocomplete while typing and Tab inserts the selected snippet", async () => {
    const root = await agentDir();
    const target = editor();
    target.setAutocompleteProvider(createSnippetAutocompleteProvider(
      new CombinedAutocompleteProvider([], root, null),
      () => parseSnippets('{"a":"First phrase","b":"Second phrase"}'),
    ));
    target.handleInput(";");
    await vi.waitFor(() => expect(target.isShowingAutocomplete()).toBe(true));
    target.handleInput("\x1b[B"); // Select the second snippet.
    target.handleInput("\t");
    expect(target.getText()).toBe("Second phrase");
  });

  it("inserts multiline Unicode text literally, preserving all surrounding lines and placing the cursor before the suffix", async () => {
    const root = await agentDir();
    const provider = createSnippetAutocompleteProvider(new CombinedAutocompleteProvider([], root, null), () =>
      parseSnippets(JSON.stringify({ multi: "Hello 🌍\r\n;other $1 {{literal}}\r" })),
    );
    const lines = ["above", "前 ;multi! suffix", "below"];
    const suggestions = await provider.getSuggestions(lines, 1, "前 ;multi".length, options);
    const result = provider.applyCompletion(lines, 1, "前 ;multi".length, suggestions!.items[0]!, suggestions!.prefix);
    expect(result).toEqual({
      lines: ["above", "前 Hello 🌍", ";other $1 {{literal}}", "! suffix", "below"],
      cursorLine: 3,
      cursorCol: 0,
    });
    expect(lines).toEqual(["above", "前 ;multi! suffix", "below"]);
  });

  it("delegates unrelated references and slash commands to the existing provider", async () => {
    const root = await agentDir();
    const base = new CombinedAutocompleteProvider([{ name: "help", description: "Help" }], root, null);
    const provider = createSnippetAutocompleteProvider(base, () => parseSnippets('{"review":"Review"}'));
    for (const text of ["word;review", "(;review", "\\;review", ";review ", "/he", "@file", "normal text"]) {
      expect(await provider.getSuggestions([text], 0, text.length, options))
        .toEqual(await base.getSuggestions([text], 0, text.length, options));
      expect(provider.shouldTriggerFileCompletion?.([text], 0, text.length))
        .toBe(base.shouldTriggerFileCompletion?.([text], 0, text.length));
    }
    const suggestions = await provider.getSuggestions(["/he"], 0, 3, options);
    expect(provider.applyCompletion(["/he"], 0, 3, suggestions!.items[0]!, suggestions!.prefix))
      .toEqual(base.applyCompletion(["/he"], 0, 3, suggestions!.items[0]!, suggestions!.prefix));
  });

  it("refreshes definitions without stacking providers across sessions", async () => {
    const root = await agentDir();
    const harness = extensionHarness(new CombinedAutocompleteProvider([], root, null));
    await writeFile(join(root, "snippets.json"), '{"a":"Old phrase"}');
    await harness.start();
    await writeFile(join(root, "snippets.json"), '{"b":"New phrase"}');
    await harness.start();
    const result = await harness.provider.getSuggestions([";"], 0, 1, options);
    expect(result?.items.map((item) => item.value)).toEqual([";b"]);
    expect(harness.installations).toBe(1);
    expect(harness.warnings).toEqual([]);
    await harness.rebind();
    expect(harness.installations).toBe(2);
    expect((await harness.provider.getSuggestions([";"], 0, 1, options))?.items.map((item) => item.value))
      .toEqual([";b"]);
  });

  it("accepts a missing config, warns on malformed or invalid config, and ignores non-TUI modes", async () => {
    const root = await agentDir();
    const harness = extensionHarness(new CombinedAutocompleteProvider([], root, null));
    await harness.start("rpc");
    expect(harness.installations).toBe(0);
    await harness.start();
    expect(harness.warnings).toEqual([]);
    for (const source of ['{', '[]', '{"good":"Yes","bad":42}', '{";name":"No"}']) {
      await writeFile(join(root, "snippets.json"), source);
      await harness.start();
      expect(harness.warnings.at(-1)).toContain(join(root, "snippets.json"));
      expect((await harness.provider.getSuggestions([";"], 0, 1, options))?.items).toEqual([]);
    }
    expect(harness.warnings).toHaveLength(4);
  });
});
