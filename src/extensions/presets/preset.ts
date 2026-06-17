import * as fs from "node:fs";
import * as path from "node:path";

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseModelString, getFiles } from "../../shared/parse.js";

/**
 * Utilities for reading and applying Pi preset files.
 *
 * A preset is stored as a Markdown file with required `name` and `description`
 * frontmatter. Optional frontmatter can select a model, thinking level, tools,
 * and skills; the Markdown body becomes the preset's system prompt.
 *
 * @example
 * ```md
 * ---
 * name: typescript-review
 * description: Review TypeScript changes
 * model: anthropic/claude-sonnet-4:high
 * tools: read, grep
 * skills: tailwind-css
 * ---
 * You are reviewing a TypeScript pull request.
 * ```
 */

/** Parsed preset definition loaded from a Markdown preset file. */
export interface Preset {
  /** Stable preset name used for selection, lookup, and persisted session state. */
  name: string;

  /** Short human-readable summary shown in preset selectors and help text. */
  description: string;

  /** Model id parsed from frontmatter, for example `gpt-5.5` from `openai-codex/gpt-5.5:low`. */
  model?: string;

  /** Provider id parsed from frontmatter, for example `openai-codex`. */
  provider?: string;

  /** Optional thinking level parsed from the model string suffix. */
  thinking?: ThinkingLevel;

  /** Tool names that should be active while this preset is selected. */
  tools?: string[];

  /** Skill names that should be active while this preset is selected. */
  skills?: string[];

  /** Markdown body appended to the active system prompt before the agent starts. */
  instructions: string;
}

/**
 * Applies runtime settings from a preset to the current Pi session.
 *
 * This updates only settings represented by the preset:
 * - `provider` + `model` select the active model when it exists in the registry.
 * - `thinking` selects the active thinking level.
 * - `tools` replaces the active tool set with the known tools listed by the preset.
 *
 * Invalid model or tool names are reported as UI warnings instead of throwing,
 * because presets may be shared across environments with different providers or
 * extension-provided tools.
 *
 * @param preset - Parsed preset definition to apply.
 * @param pi - Extension API used to mutate the active Pi session.
 * @param ctx - Extension context used for model lookup and user notifications.
 * @returns `true` once the preset has been processed.
 */
export async function apply(
  preset: Preset,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  // Apply model
  if (preset.provider && preset.model) {
    const model = ctx.modelRegistry.find(preset.provider, preset.model);
    if (model) {
      const success = await pi.setModel(model);
      if (!success) {
        ctx.ui.notify(
          `Preset ${preset.name}: Model set failed, ensure API key is available in the environment`,
          "warning",
        );
      }
    } else {
      ctx.ui.notify(
        `Preset ${preset.name}: Model ${preset.provider}/${preset.model} not found.`,
        "warning",
      );
    }
  }

  if (preset.thinking) {
    pi.setThinkingLevel(preset.thinking);
  }

  // Apply skills
  if (preset.skills) {
    const allSkills = pi.getAllSkills();
    const skillNames = new Set(allSkills.map((skill) => skill.name));

    const wanted = preset.skills.filter((name) => skillNames.has(name));
    const missing = preset.skills.filter((name) => !skillNames.has(name));
    if (missing.length > 0) {
      ctx.ui.notify(`Preset ${preset.name}: Unknown skills: ${missing.join(", ")}`, "warning");
    }

    pi.setActiveSkills(wanted);
  }

  // Apply tools
  if (preset.tools) {
    const allTools = pi.getAllTools();
    const toolNames = new Set(allTools.map((tool) => tool.name));

    const wanted = preset.tools.filter((name) => toolNames.has(name));
    const missing = preset.tools.filter((name) => !toolNames.has(name));
    if (missing.length > 0) {
      ctx.ui.notify(`Preset ${preset.name}: Unknown tools: ${missing.join(", ")}`, "warning");
    }

    pi.setActiveTools(wanted);
  }

  return true;
}

/**
 * Loads a preset from a Markdown file.
 *
 * The file must contain frontmatter with at least `name` and `description`.
 * Optional comma-separated `tools` and `skills` values are normalized into
 * arrays. The optional `model` value is parsed with {@link parseModelString},
 * so values such as `provider/model:thinking` can populate `provider`, `model`,
 * and `thinking` separately.
 *
 * Missing files, unreadable files, and files without required frontmatter return
 * `undefined`. Callers can therefore scan directories without treating every
 * invalid file as an exceptional condition.
 *
 * @param file - Absolute or relative path to a preset Markdown file.
 * @returns The parsed preset, or `undefined` when the file is not a valid preset.
 */
export async function load(file: string): Promise<Preset | undefined> {
  let content: string;
  try {
    content = await fs.promises.readFile(file, "utf-8");
  } catch {
    return undefined;
  }

  const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
  if (!frontmatter.name || !frontmatter.description) {
    return undefined;
  }

  let provider: string | undefined;
  let model: string | undefined;
  let thinking: ThinkingLevel | undefined;
  if (frontmatter.model) {
    ({ provider, model, thinking } = parseModelString(frontmatter.model));
  }

  const tools = frontmatter.tools
    ?.split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);

  const skills = frontmatter.skills
    ?.split(",")
    .map((t: string) => t.trim())
    .filter(Boolean);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    provider: provider,
    model: model,
    thinking: thinking,
    tools: tools,
    skills: skills,
    instructions: body,
  };
}

/**
 * Loads every valid preset Markdown file from a directory tree.
 *
 * Invalid preset files are skipped. The returned order follows the async file
 * traversal order from {@link getFiles}.
 */
async function loadPresetsFromDir(dir: string): Promise<Preset[]> {
  const store: Preset[] = [];

  for await (const file of getFiles(dir, (entry) => {
    return entry.name.endsWith(".md") && entry.isFile();
  })) {
    const preset = await load(file);
    if (preset) {
      store.push(preset);
    }
  }

  return store;
}

/**
 * Loads presets from the global preset directory and then the current project.
 *
 * Global presets live in the user's Pi agent directory under `presets/`.
 * Project presets live in `<cwd>/.pi/presets/`. Project presets are returned
 * after global presets so callers that de-duplicate by name can let project
 * definitions override global defaults.
 *
 * @param cwd - Current working directory used to locate project presets.
 * @returns All valid global and project presets.
 */
export async function loadCascade(cwd: string): Promise<Preset[]> {
  const globalPath = path.join(getAgentDir(), "presets");
  const projectPath = path.join(cwd, ".pi", "presets");

  const globalPresets = await loadPresetsFromDir(globalPath);
  const projectPresets = await loadPresetsFromDir(projectPath);

  return [...globalPresets, ...projectPresets];
}
