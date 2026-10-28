import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyBlock, copyLastAssistant, copyMessage, copyRange, editLastAssistant } from "../support/copy-actions.ts";
import { copyAutocomplete } from "../support/copy-autocomplete.ts";

export default function copyExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider(copyAutocomplete);
	});
	pi.registerCommand("copy", {
		description: "Copy assistant text, a message, an inclusive active-branch range, or a Markdown block; open the last response in an editor",
		handler: async (args, ctx) => {
			// Throw rather than notify: print/JSON modes have no notification UI.
			if (ctx.mode !== "tui") throw new Error("/copy requires TUI mode");
			switch (args.trim()) {
				case "": await copyLastAssistant(ctx); break;
				case "message": await copyMessage(ctx); break;
				case "range": await copyRange(ctx); break;
				case "block": await copyBlock(ctx); break;
				case "edit": await editLastAssistant(ctx, pi.getSettings().externalEditor); break;
				default: ctx.ui.notify("Usage: /copy [message|range|block|edit]", "warning");
			}
		},
	});
}
