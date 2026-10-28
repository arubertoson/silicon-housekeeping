import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const commands = [
	{ value: "message", label: "message", description: "Search and copy a user or assistant message" },
	{ value: "range", label: "range", description: "Copy an inclusive range from the active branch" },
	{ value: "block", label: "block", description: "Copy a fence or blockquote from the last assistant message" },
	{ value: "edit", label: "edit", description: "Open the last assistant response in your external editor" },
];

function argumentPrefix(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	if (lines.length !== 1 || cursorLine !== 0) return undefined;
	return /^\s*\/copy[ \t]+([a-z]*)$/.exec(lines[0].slice(0, cursorCol))?.[1];
}

// Pi filters built-in command collisions out of command-registration completions.
// Wrap its provider instead; leave command dispatch and the editor unchanged.
export function copyAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const prefix = argumentPrefix(lines, cursorLine, cursorCol);
			if (prefix === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix, items: commands.filter((command) => command.value.startsWith(prefix)) };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (argumentPrefix(lines, cursorLine, cursorCol) !== undefined) return false;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
		},
	};
}
