import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  getAgentDir,
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, type KeyId } from "@earendil-works/pi-tui";

/**
 * Keymaps binds multi-key sequences to Pi slash commands.
 *
 * Configuration is loaded from both locations, in order:
 * - ~/.pi/agent/keymaps.json
 * - <cwd>/.pi/keymaps.json
 *
 * Example:
 * [
 *   { "sequence": ["ctrl+x", "n"], "description": "New session", "command": "new" },
 *   { "sequence": ["ctrl+x", "m"], "description": "Switch model", "command": "model" }
 * ]
 */

const ESCAPE_KEY = "escape";
const SEQUENCE_TIMEOUT_MS = 1500;
const KEYMAP_FILE = "keymaps.json";

type Notify = (message: string, type: "info" | "warning" | "error") => void;

export type KeymapEntry = {
  /** Key sequence to match. Each key must be a Pi TUI KeyId such as "ctrl+x" or "escape". */
  sequence: KeyId[];
  /** Human-readable label used for documentation/config clarity. */
  description?: string;
  /** Pi slash command name without the leading slash. */
  command: string;
  /** Raw argument string passed to the command. */
  args?: string;
};

type KeymapNode = {
  entry?: KeymapEntry;
  children: Record<string, KeymapNode>;
};

export class KeymapTree {
  active: KeymapNode | undefined;

  private root: Record<string, KeymapNode> = {};
  private entries = 0;

  get size(): number {
    return this.entries;
  }

  get isEmpty(): boolean {
    return this.entries === 0;
  }

  next(input: string): KeymapNode | undefined {
    const previous = this.active;
    const children = this.active ? this.active.children : this.root;
    const key = Object.keys(children).find(
      (key) => input === key || matchesKey(input, key as KeyId),
    );

    this.active = key ? children[key] : undefined;

    // If a sequence is already active, keep it active on an invalid continuation.
    // This lets users recover from a mistyped continuation until the timeout resets.
    if (!this.active && previous) {
      this.active = previous;
    }

    return this.active;
  }

  reset(): void {
    this.active = undefined;
  }

  add(entry: KeymapEntry): void {
    let children = this.root;
    let active: KeymapNode | undefined;

    for (const key of entry.sequence) {
      children[key] ??= { children: {} };
      active = children[key];
      children = active.children;
    }

    if (!active) {
      throw new Error("Empty key sequence.");
    }

    if (active.entry) {
      throw new Error(`Duplicate keymap for ${entry.sequence.join(", ")}.`);
    }

    active.entry = entry;
    this.entries += 1;
  }
}

const DELIMITER = "+";
const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
const BASE_KEYS = new Set<string>([
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  ...Object.values(Key).flatMap((value) => (typeof value === "string" ? [value] : [])),
]);

export function isKeyId(key: unknown): key is KeyId {
  if (typeof key !== "string" || key.length === 0) {
    return false;
  }

  let rest = key;
  const seen = new Set<string>();

  while (true) {
    const modifier = MODIFIERS.find((modifier) => rest.startsWith(`${modifier}${DELIMITER}`));

    if (!modifier) break;

    if (seen.has(modifier)) {
      return false;
    }

    seen.add(modifier);
    rest = rest.slice(modifier.length + DELIMITER.length);
  }

  return BASE_KEYS.has(rest);
}

function assertObject(file: string, item: unknown): asserts item is Record<string, unknown> {
  if (!item || typeof item !== "object") {
    throw new Error(`Keymap file ${file} contains a non-object entry.`);
  }
}

function parseKeymapEntry(file: string, item: unknown): KeymapEntry {
  assertObject(file, item);

  const { sequence, description, command, args } = item;

  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error(`Keymap file ${file} contains an entry with an invalid sequence.`);
  }

  for (const key of sequence) {
    if (!isKeyId(key)) {
      throw new Error(`Keymap file ${file} contains an invalid key: ${String(key)}.`);
    }
  }

  if (typeof command !== "string" || command.length === 0) {
    throw new Error(`Keymap file ${file} contains an entry with an invalid command.`);
  }

  if (description !== undefined && typeof description !== "string") {
    throw new Error(`Keymap file ${file} contains an entry with an invalid description.`);
  }

  if (args !== undefined && typeof args !== "string") {
    throw new Error(`Keymap file ${file} contains an entry with invalid args.`);
  }

  return {
    sequence,
    description,
    command,
    args,
  };
}

async function loadKeymapFile(file: string): Promise<KeymapEntry[]> {
  let content: string;

  try {
    content = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }

  let raw: unknown;

  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`Keymap file ${file} is not valid JSON.`);
  }

  if (!Array.isArray(raw)) {
    throw new Error(`Keymap file ${file} must contain an array.`);
  }

  return raw.map((item) => parseKeymapEntry(file, item));
}

function notify(
  ctx: { ui: { notify: Notify } },
  message: string,
  type: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    // The context may be stale after session replacement commands such as /new.
  }
}

async function createKeymapTree(cwd: string, notify: Notify): Promise<KeymapTree> {
  const files = [join(getAgentDir(), KEYMAP_FILE), join(cwd, ".pi", KEYMAP_FILE)];
  const tree = new KeymapTree();

  for (const file of files) {
    let entries: KeymapEntry[];

    try {
      entries = await loadKeymapFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(`Failed to load keymaps from ${file}: ${message}`, "warning");
      continue;
    }

    for (const entry of entries) {
      try {
        tree.add(entry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(`Failed to load keymap ${entry.sequence.join(", ")}: ${message}`, "warning");
      }
    }
  }

  return tree;
}

class KeymapEditor extends CustomEditor {
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: KeybindingsManager,
    private readonly pi: ExtensionAPI,
    private readonly keymaps: KeymapTree,
    private readonly notify: Notify,
  ) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    if (this.keymaps.active && matchesKey(data, ESCAPE_KEY)) {
      this.reset();
      return;
    }

    const active = this.keymaps.next(data);
    if (!this.keymaps.active && !active) {
      super.handleInput(data);
      return;
    }

    if (active?.entry) {
      void this.runKeymap(active.entry).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.notify(`Failed to run keymap: ${message}`, "warning");
      });
      this.reset();
      return;
    }

    // Reset the sequence if the user pauses part-way through a keymap.
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => this.reset(), SEQUENCE_TIMEOUT_MS);
  }

  private async runKeymap(entry: KeymapEntry): Promise<void> {
    this.notify(`Running ${entry.command}`, "info");

    const results = await this.pi.executeCommand(entry.command, { args: entry.args });
    if (!results.handled) {
      this.notify(results.error ?? `Failed to run ${entry.command}`, "warning");
    }
  }

  private reset(): void {
    if (this.timeout) clearTimeout(this.timeout);

    this.timeout = undefined;
    this.keymaps.reset();
  }
}

export default function keymaps(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const notifyUser: Notify = (message, type) => notify(ctx, message, type);
    const keymaps = await createKeymapTree(ctx.cwd, notifyUser);

    if (keymaps.isEmpty) {
      notifyUser(`No ${KEYMAP_FILE} entries found.`, "warning");
      return;
    }

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new KeymapEditor(tui, theme, keybindings, pi, keymaps, notifyUser),
    );
  });
}
