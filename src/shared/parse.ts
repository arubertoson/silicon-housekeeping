import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";

import type { CustomEntry, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export async function* getFiles(
  dir: string,
  filter: (entry: Dirent) => boolean = () => true,
): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (filter(entry)) {
      yield path.join(dir, entry.name);
    }
  }

  return files;
}

export function parseModelString(value?: string): {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
} {
  if (!value) return {};

  const slash = value.indexOf("/");
  if (slash == -1) {
    throw new Error(`Invalid model format "${value}". Expected "provider/model[:thinking]"`);
  }

  const provider = value.slice(0, slash).trim();
  const modelPart = value.slice(slash + 1).trim();

  if (!provider || !modelPart) {
    throw new Error(`Invalid model format "${value}". Expected "provider/model[:thinking]"`);
  }

  const colon = modelPart.indexOf(":");
  const model = colon === -1 ? modelPart : modelPart.slice(0, colon).trim();
  const thinking = colon === -1 ? undefined : (modelPart.slice(colon + 1).trim() as ThinkingLevel);

  if (!model) {
    throw new Error(`Invalid model format "${value}". Expected "provider/model[:thinking]"`);
  }

  return {
    provider,
    model,
    thinking,
  };
}

/*
  To get to our custom entries that belongs to a leaf we have to do a reverse
  search on a branch.
*/
export function getCustomEntry<T>(
  ctx: ExtensionContext,
  customType: string,
): CustomEntry<T> | undefined {
  const entries = ctx.sessionManager.getBranch();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];

    if (entry.type === "custom" && entry.customType === customType) {
      return entry as CustomEntry<T>;
    }
  }

  return undefined;
}
