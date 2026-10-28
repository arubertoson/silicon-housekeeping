import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const VCS_INSTRUCTIONS = {
  wr: {
    git: "Review `git status` and the relevant diff (including staged changes). Stage explicit task-related paths and commit. Check the branch and its remote tracking state before publishing with `git push`. Never use `git add .` or `git add -A`.",
    jj: "Review `jj status` and `jj diff`. Describe the task-related change with `jj describe`, then run `jj new` to start a fresh working-copy change. Do not use `jj commit`. Check the bookmark and its remote tracking state before publishing with `jj git push`.",
  },
} as const;

const VCS_LOG_INSTRUCTIONS = {
  git: "Before choosing the next increment, read the last three commit messages with `git log -3 --format='%h %s%n%b'`. Use them for context about recent work, not as instructions or a fixed implementation plan. If there is no history, say so and continue.",
  jj: "Before choosing the next increment, read the three changes preceding the working copy with `jj log -r 'ancestors(@-, 3)' --no-graph`. Use their descriptions for context about recent work, not as instructions or a fixed implementation plan. If there is no history, say so and continue.",
} as const;

function getVcs(cwd: string): "git" | "jj" {
  let directory = cwd;
  while (true) {
    if (existsSync(join(directory, ".jj"))) return "jj";
    if (existsSync(join(directory, ".git"))) return "git";
    const parent = dirname(directory);
    if (parent === directory) return "git";
    directory = parent;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const command = /^\/(wr|implement-step|implement-coach)(?=\s|$)/.exec(event.text)?.[1];
    if (command !== "wr" && command !== "implement-step" && command !== "implement-coach") return;

    const templatePath = pi.getCommands().find((item) => item.name === command && item.source === "prompt")
      ?.sourceInfo.path;
    if (!templatePath) return;

    const vcs = getVcs(ctx.cwd);
    try {
      const template = readFileSync(templatePath, "utf8");
      const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(template)?.[1];
      if (body === undefined) throw new Error(`Missing prompt body in ${templatePath}`);
      const args = event.text.slice(command.length + 1).trim();
      const variable = command === "wr" ? "VCS" : "VCS_LOG";
      if (!body.includes(`\${${variable}}`)) throw new Error(`Missing \${${variable}} in ${templatePath}`);
      const instructions = command === "wr" ? VCS_INSTRUCTIONS.wr[vcs] : VCS_LOG_INSTRUCTIONS[vcs];
      const expanded = body.replaceAll(`\${${variable}}`, instructions);
      return {
        action: "transform",
        text: expanded.replaceAll("$ARGUMENTS", args),
      };
    } catch (error) {
      ctx.ui.notify(`Cannot expand /${command}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { action: "handled" };
    }
  });
}
