// Editor snippets: ;name + Tab. Definitions live in <agent-dir>/snippets.json.
import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, type AutocompleteProvider, type EditorComponent } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SNIPPET_NAME = /^[A-Za-z0-9_-]+$/;
const SNIPPET_REFERENCE = /(?:^|\s)(;[A-Za-z0-9_-]*)$/;
const SNIPPET_FIELD = /\$\{([1-9]\d*)(?::([^}]*))?\}/g;
const DELETE_KEYS = ["backspace", "delete", "ctrl+backspace", "alt+backspace", "ctrl+w", "alt+d", "alt+delete", "ctrl+u", "ctrl+k", "ctrl+d"] as const;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type SnippetField = {
  id: number;
  sourceOrder: number;
  start: number;
  end: number;
  defaultText: string;
  edited: boolean;
};

type SnippetExpansion = {
  text: string;
  fields: SnippetField[];
};

type SnippetSession = {
  fields: SnippetField[];
  activeField: number;
  start: number;
  end: number;
  lastText: string;
  selectionActive: boolean;
};

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type Cursor = { line: number; col: number };
type CursorEditor = EditorComponent & { getCursor?: () => Cursor };
type EditorBinding = {
  editor: CursorEditor;
  handleInput: (data: string) => void;
  endsSession: (data: string) => boolean;
};

export function parseSnippets(source: string): ReadonlyMap<string, string> {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object mapping snippet names to strings.");
  }

  const snippets = new Map<string, string>();
  for (const [name, text] of Object.entries(value)) {
    if (!SNIPPET_NAME.test(name)) {
      throw new Error(`Invalid snippet name ${JSON.stringify(name)}: use letters, digits, underscores, or hyphens (without ;).`);
    }
    if (typeof text !== "string") {
      throw new Error(`Snippet ${JSON.stringify(name)} must contain a string.`);
    }
    const normalized = text.replace(/\r\n?/g, "\n");
    expandSnippetTemplate(normalized, name);
    snippets.set(name, normalized);
  }
  return snippets;
}

function expandSnippetTemplate(source: string, name = "template"): SnippetExpansion {
  const fields: SnippetField[] = [];
  const ids = new Set<number>();
  let text = "";
  let sourceOffset = 0;
  let match: RegExpExecArray | null;
  SNIPPET_FIELD.lastIndex = 0;

  while ((match = SNIPPET_FIELD.exec(source)) !== null) {
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || ids.has(id)) {
      throw new Error(`Snippet ${JSON.stringify(name)} has invalid field ${JSON.stringify(match[1])}: use unique positive safe integers.`);
    }
    ids.add(id);

    text += source.slice(sourceOffset, match.index);
    const value = match[2] ?? "";
    const start = text.length;
    text += value;
    fields.push({ id, sourceOrder: fields.length, start, end: text.length, defaultText: value, edited: false });
    sourceOffset = match.index + match[0].length;
  }
  text += source.slice(sourceOffset);

  fields.sort((a, b) => a.id - b.id || a.sourceOrder - b.sourceOrder);
  return { text, fields };
}

function referenceBeforeCursor(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
  return (lines[cursorLine] ?? "").slice(0, cursorCol).match(SNIPPET_REFERENCE)?.[1];
}

function absoluteOffset(lines: string[], line: number, col: number): number {
  let offset = col;
  for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset;
}

function positionAtOffset(lines: string[], offset: number): { line: number; col: number } {
  let remaining = offset;
  for (let line = 0; line < lines.length; line++) {
    const length = lines[line]?.length ?? 0;
    if (remaining <= length) return { line, col: remaining };
    remaining -= length + 1;
  }
  const lastLine = Math.max(0, lines.length - 1);
  return { line: lastLine, col: lines[lastLine]?.length ?? 0 };
}

export function createSnippetAutocompleteProvider(
  current: AutocompleteProvider,
  getSnippets: () => ReadonlyMap<string, string>,
  onExpand?: (session: Omit<SnippetSession, "activeField" | "selectionActive">) => void,
  isSnippetSessionActive: () => boolean = () => false,
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ";"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if (isSnippetSessionActive()) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const prefix = referenceBeforeCursor(lines, cursorLine, cursorCol);
      if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const query = prefix.slice(1);
      const snippets = getSnippets();
      // Explicit Tab with an exact name expands immediately, even if longer names also match.
      const names = options.force && snippets.has(query)
        ? [query]
        : [...snippets.keys()].filter((name) => name.startsWith(query)).sort();
      return {
        prefix,
        items: names.map((name) => ({
          value: `;${name}`,
          label: `;${name}`,
          description: snippets.get(name)!.replace(/\s+/g, " ").slice(0, 120),
        })),
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (isSnippetSessionActive()) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      const template = item.value.startsWith(";") ? getSnippets().get(item.value.slice(1)) : undefined;
      if (template === undefined || !prefix.startsWith(";") ||
          referenceBeforeCursor(lines, cursorLine, cursorCol) !== prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }

      const expansion = expandSnippetTemplate(template, item.value.slice(1));
      const line = lines[cursorLine]!;
      const before = line.slice(0, cursorCol - prefix.length);
      const after = line.slice(cursorCol);
      const inserted = expansion.text.split("\n");
      const last = inserted.length - 1;
      inserted[0] = before + inserted[0];
      inserted[last] += after;
      const resultLines = [...lines.slice(0, cursorLine), ...inserted, ...lines.slice(cursorLine + 1)];

      const insertionStart = absoluteOffset(lines, cursorLine, cursorCol - prefix.length);
      const firstFieldOffset = expansion.fields.length > 0
        ? insertionStart + expansion.fields[0]!.start
        : insertionStart + expansion.text.length;
      const cursor = positionAtOffset(resultLines, firstFieldOffset);

      if (expansion.fields.length > 0) {
        onExpand?.({
          fields: expansion.fields.map((field) => ({ ...field, start: field.start + insertionStart, end: field.end + insertionStart })),
          start: insertionStart,
          end: insertionStart + expansion.text.length,
          lastText: resultLines.join("\n"),
        });
      }

      return { lines: resultLines, cursorLine: cursor.line, cursorCol: cursor.col };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (isSnippetSessionActive()) return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      // Pi gates explicit Tab behind this hook, even for non-file providers.
      if (referenceBeforeCursor(lines, cursorLine, cursorCol) !== undefined) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function textOffset(editor: CursorEditor): number | undefined {
  const cursor = editor.getCursor?.();
  if (!cursor) return undefined;
  const lines = editor.getText().split("\n");
  return absoluteOffset(lines, cursor.line, cursor.col);
}

function graphemeCount(text: string): number {
  return [...graphemes.segment(text)].length;
}

function isTextInput(data: string): boolean {
  if (data.includes("\x1b[200~")) return true;
  if (decodeKittyPrintable(data) !== undefined) return true;
  return !data.includes("\x1b") && data.length > 0 && data.charCodeAt(0) >= 32;
}

function isDeleteInput(data: string): boolean {
  return DELETE_KEYS.some((key) => matchesKey(data, key));
}

function updateSessionAfterEdit(
  session: SnippetSession,
  before: string,
  after: string,
  cursorBefore: number | undefined,
  cursorAfter: number | undefined,
): boolean {
  if (cursorBefore === undefined || cursorAfter === undefined) return false;
  const delta = after.length - before.length;
  if (delta === 0) return false;

  // Observe the editor's result, not the key that produced it. Cursor anchors
  // disambiguate edits beside repeated text; only a single insertion or deletion
  // inside the active field keeps navigation alive.
  const start = delta > 0 ? cursorBefore : cursorAfter;
  const oldEnd = delta > 0 ? start : start - delta;
  const newEnd = delta > 0 ? start + delta : start;
  if (delta > 0 && cursorAfter !== newEnd) return false;
  if (delta < 0 && cursorBefore !== start && cursorBefore !== oldEnd) return false;
  if (before.slice(0, start) !== after.slice(0, start) ||
      before.slice(oldEnd) !== after.slice(newEnd)) return false;

  const active = session.fields[session.activeField]!;
  if (start < active.start || oldEnd > active.end) return false;

  active.end += delta;
  active.edited = true;
  for (const field of session.fields) {
    // Physical order, not navigation order, also distinguishes adjacent empty fields.
    if (field.sourceOrder > active.sourceOrder) {
      field.start += delta;
      field.end += delta;
    }
  }
  session.end += delta;
  session.lastText = after;
  session.selectionActive = false;
  return true;
}

function updateSessionStatus(ui: ExtensionUIContext, session: SnippetSession): void {
  const hint = session.selectionActive ? " · type to replace default" : "";
  ui.setStatus?.(
    "snippets",
    `Snippet ${session.activeField + 1}/${session.fields.length}${hint} · Tab next · Shift+Tab previous · Esc finish`,
  );
}

function installSnippetEditor(ui: ExtensionUIContext, onInput: (binding: EditorBinding, data: string) => void): {
  factory?: EditorFactory;
  binding?: EditorBinding;
} {
  const current = ui.getEditorComponent();
  let binding: EditorBinding | undefined;
  const factory: EditorFactory = (tui, theme, keybindings) => {
    const editor = (current
      ? current(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true })) as CursorEditor;
    const handleInput = editor.handleInput.bind(editor);
    const localBinding: EditorBinding = {
      editor,
      handleInput,
      endsSession: (data) => keybindings.matches(data, "tui.editor.undo") ||
        keybindings.matches(data, "tui.input.submit") ||
        keybindings.matches(data, "app.message.followUp") ||
        keybindings.matches(data, "app.clear"),
    };
    binding = localBinding;
    editor.handleInput = (data) => onInput(localBinding, data);
    return editor;
  };
  ui.setEditorComponent(factory);
  return { factory, get binding() { return binding; } };
}

export default function snippetsExtension(pi: ExtensionAPI): void {
  let snippets: ReadonlyMap<string, string> = new Map();
  let installedUI: ExtensionUIContext | undefined;
  let installedEditorUI: ExtensionUIContext | undefined;
  let wrappedEditorFactory: EditorFactory | undefined;
  let editorBinding: EditorBinding | undefined;
  let editorInputUnsubscribe: (() => void) | undefined;
  let activeSession: SnippetSession | undefined;

  function finishSession(binding?: EditorBinding): void {
    const session = activeSession;
    if (!session) return;
    if (binding) moveCursor(binding, session.end);
    activeSession = undefined;
    (installedEditorUI ?? installedUI)?.setStatus?.("snippets", undefined);
  }

  function moveCursor(binding: EditorBinding, target: number): void {
    const current = textOffset(binding.editor);
    if (current === undefined) return;
    const text = binding.editor.getText();
    const destination = Math.max(0, Math.min(target, text.length));
    if (destination === current) return;
    const sequence = destination < current ? "\x1b[D" : "\x1b[C";
    const count = graphemeCount(text.slice(Math.min(current, destination), Math.max(current, destination)));
    for (let i = 0; i < count; i++) binding.handleInput(sequence);
  }

  function dispatchEditorInput(binding: EditorBinding, data: string): void {
    const session = activeSession;
    const before = binding.editor.getText();
    const cursorBefore = textOffset(binding.editor);
    binding.handleInput(data);
    if (!session || activeSession !== session) return;
    const after = binding.editor.getText();
    if (after !== before && !updateSessionAfterEdit(session, before, after, cursorBefore, textOffset(binding.editor))) {
      finishSession();
      return;
    }
    if (installedEditorUI && activeSession) updateSessionStatus(installedEditorUI, activeSession);
  }

  function clearSelectedDefault(binding: EditorBinding): void {
    const session = activeSession;
    const field = session?.fields[session.activeField];
    if (!session || !field) return;
    session.selectionActive = false;
    const defaultValue = binding.editor.getText().slice(field.start, field.end);
    for (let i = 0; i < graphemeCount(defaultValue); i++) {
      if (activeSession !== session || field.end === field.start) break;
      dispatchEditorInput(binding, "\x1b[3~");
    }
  }

  function handleSnippetInput(binding: EditorBinding, data: string): void {
    editorBinding = binding;
    const session = activeSession;
    if (!session) {
      binding.handleInput(data);
      return;
    }

    if (session.lastText !== binding.editor.getText() || binding.endsSession(data)) {
      finishSession();
      binding.handleInput(data);
      return;
    }

    if (matchesKey(data, "tab")) {
      if (session.activeField === session.fields.length - 1) {
        finishSession(binding);
        return;
      }
      session.activeField++;
      const field = session.fields[session.activeField]!;
      session.selectionActive = !field.edited && field.defaultText.length > 0;
      moveCursor(binding, session.selectionActive ? field.start : field.end);
      if (installedEditorUI) updateSessionStatus(installedEditorUI, session);
      return;
    }

    if (matchesKey(data, "shift+tab")) {
      if (session.activeField > 0) {
        session.activeField--;
        const field = session.fields[session.activeField]!;
        session.selectionActive = !field.edited && field.defaultText.length > 0;
        moveCursor(binding, session.selectionActive ? field.start : field.end);
        if (installedEditorUI) updateSessionStatus(installedEditorUI, session);
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      finishSession(binding);
      return;
    }

    const activeField = session.fields[session.activeField]!;
    if (session.selectionActive && textOffset(binding.editor) !== activeField.start) {
      session.selectionActive = false;
    }
    if (session.selectionActive && (isTextInput(data) || isDeleteInput(data))) {
      clearSelectedDefault(binding);
      if (isTextInput(data)) dispatchEditorInput(binding, data);
      return;
    }

    session.selectionActive = false;
    dispatchEditorInput(binding, data);
    if (activeSession === session && installedEditorUI) updateSessionStatus(installedEditorUI, session);
  }

  function ensureEditorWrapped(ui: ExtensionUIContext): void {
    if (typeof ui.getEditorComponent !== "function" || typeof ui.setEditorComponent !== "function") return;
    const currentFactory = ui.getEditorComponent();
    if (wrappedEditorFactory !== undefined && currentFactory === wrappedEditorFactory) return;

    const previousOffset = editorBinding ? textOffset(editorBinding.editor) : undefined;
    const installed = installSnippetEditor(ui, handleSnippetInput);
    wrappedEditorFactory = installed.factory;
    editorBinding = installed.binding;
    if (previousOffset !== undefined && editorBinding) moveCursor(editorBinding, previousOffset);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    activeSession = undefined;
    installedEditorUI?.setStatus?.("snippets", undefined);
    if (installedEditorUI !== ctx.ui) {
      editorInputUnsubscribe?.();
      editorInputUnsubscribe = undefined;
      installedEditorUI = ctx.ui;
    }
    const path = join(getAgentDir(), "snippets.json");
    snippets = new Map();
    try {
      snippets = parseSnippets(await readFile(path, "utf8"));
    } catch (error) {
      // A missing file simply means there are no snippets configured yet.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not load ${path}: ${message}`, "warning");
      }
    }

    const hasFields = [...snippets.values()].some((snippet) => expandSnippetTemplate(snippet).fields.length > 0);
    if (hasFields) {
      if (!editorInputUnsubscribe && typeof ctx.ui.onTerminalInput === "function") {
        editorInputUnsubscribe = ctx.ui.onTerminalInput(() => {
          ensureEditorWrapped(ctx.ui);
          return undefined;
        });
      }
      ensureEditorWrapped(ctx.ui);
    }
    if (installedUI !== ctx.ui) {
      ctx.ui.addAutocompleteProvider((current) => createSnippetAutocompleteProvider(
        current,
        () => snippets,
        (expansion) => {
          if (!editorBinding?.editor.getCursor) {
            ctx.ui.notify("This editor does not expose cursor movement; snippet fields were inserted without navigation.", "warning");
            return;
          }
          activeSession = { ...expansion, activeField: 0, selectionActive: false };
          const first = activeSession.fields[0]!;
          activeSession.selectionActive = !first.edited && first.defaultText.length > 0;
          updateSessionStatus(ctx.ui, activeSession);
        },
        () => activeSession !== undefined,
      ));
      installedUI = ctx.ui;
    }
  });
}
