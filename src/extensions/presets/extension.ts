import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";

import { UniqueStore } from "../../shared/store.js";
import { getCustomEntry } from "../../shared/parse.js";

import * as preset from "./preset.js";
import type { Preset } from "./preset.js";
import type { PresetState, PresetEntry } from "./types.js";

const PRESET_CUSTOM_ENTRY_NAME = "preset-state";

async function updateDisplayStatus(state: PresetState, ctx: ExtensionContext): Promise<void> {
  if (state.active) {
    ctx.ui.setStatus("preset", ctx.ui.theme.fg("accent", `preset:${state.active.name}`));
  } else {
    ctx.ui.setStatus("preset", undefined);
  }
}

export class PresetExtension {
  private state: PresetState;

  constructor(private readonly pi: ExtensionAPI) {
    this.state = {
      index: 0,
      active: undefined,
      store: new UniqueStore<Preset>(),
    };
  }

  async onSessionStart(ctx: ExtensionContext): Promise<void> {
    const presets = await preset.loadCascade(ctx.cwd);
    for (const p of presets) {
      this.state.store.add(p);
    }

    // We validate if we have a custom entry at the current leaf/branch and
    // use the result to figure out if we want to restore the preset before
    // we start.
    const entry = getCustomEntry<PresetEntry>(ctx, PRESET_CUSTOM_ENTRY_NAME);
    if (entry?.data?.name) {
      this.state.active = this.state.store.getByName(entry.data.name);

      const success = await preset.apply(this.state.active, this.pi, ctx);
      if (!success) {
        ctx.ui.notify(`Preset ${this.state.active.name} failed to apply.`, "warning");
      }
    }

    updateDisplayStatus(this.state, ctx);
  }

  async applyByName(name: string, ctx: ExtensionContext): Promise<void> {
    const selected = this.state.store.getByName(name);
    const success = await preset.apply(selected, this.pi, ctx);
    if (!success) {
      ctx.ui.notify(`Preset ${selected.name} failed to apply.`, "warning");
      return;
    }

    this.state.active = selected;
    await updateDisplayStatus(this.state, ctx);
  }

  async onTurnStart(ctx: ExtensionContext): Promise<void> {
    const latestEntry = getCustomEntry<PresetEntry>(ctx, PRESET_CUSTOM_ENTRY_NAME);

    const currentName = this.state.active?.name ?? null;
    const previousName = latestEntry?.data?.name ?? null;

    if (previousName !== currentName) {
      this.pi.appendEntry(PRESET_CUSTOM_ENTRY_NAME, { name: currentName });
    }
  }

  async onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): Promise<BeforeAgentStartEventResult> {
    if (this.state.active) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${this.state.active.instructions}`,
      };
    }

    return event;
  }
}
