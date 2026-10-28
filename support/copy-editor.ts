import { SettingsManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function openCopyEditor(ctx: ExtensionCommandContext, text: string, configuredEditor?: string): Promise<void> {
	// Resolve the same setting, environment variables, and fallback as Pi's Ctrl+G.
	const command = SettingsManager.inMemory({ externalEditor: configuredEditor }).getExternalEditorCommand();
	const directory = await mkdtemp(join(tmpdir(), "pi-copy-editor-"));
	const filePath = join(directory, "response.md");
	try {
		await writeFile(filePath, text, { encoding: "utf8", mode: 0o600 });
		await ctx.ui.custom<void>(async (tui, _theme, _keys, done) => {
			tui.stop();
			try {
				// Match Pi 1.4's external-editor command/argument handling.
				const [editor, ...args] = command.split(" ");
				await new Promise<void>((resolve, reject) => {
					// Async spawn releases stdin correctly, including on Windows.
					const child = spawn(editor, [...args, filePath], {
						cwd: ctx.cwd,
						stdio: "inherit",
						shell: process.platform === "win32",
					});
					child.once("error", reject);
					child.once("close", (code, signal) => {
						if (code === 0) resolve();
						else reject(new Error(signal ? `Editor stopped by ${signal}` : `Editor exited with code ${code}`));
					});
				});
			} finally {
				tui.start();
				tui.requestRender(true);
			}
			done();
			return { render: () => [], invalidate: () => {} };
		});
		// Deliberately do not read edits back into Pi or touch its prompt/clipboard.
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
