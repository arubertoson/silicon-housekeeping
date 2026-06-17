import type { State } from "../../shared/state.js";
import type { UniqueStore } from "../../shared/store.js";
import type { Preset } from "./preset.js";

export type PresetState = State<Preset>;
export type PresetStore = UniqueStore<Preset>;

export interface PresetEntry {
  name: string;
}

