import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { PresetExtension } from "./extension.js";

export default function (pi: ExtensionAPI) {
  const state = new PresetExtension(pi);

  pi.on("session_start", async (_event, ctx) => state.onSessionStart(ctx));
  pi.on("turn_start", async (_event, ctx) => state.onTurnStart(ctx));
  pi.on("before_agent_start", async (event, ctx) => state.onBeforeAgentStart(event, ctx));

  pi.registerCommand("preset", {
    description: "Switch preset configuration",
    handler: async (args, ctx) => {
      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("Usage: /preset <name>", "info");
        return;
      }

      await state.applyByName(name, ctx);
    },
  });
}
