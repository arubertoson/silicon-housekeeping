import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

interface ZigEnvResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function parseZigStdDir(stdout: string): string {
  const match = stdout.match(/^\s*\.std_dir\s*=\s*("(?:\\.|[^"\\])*"),?\s*$/m);
  if (!match?.[1]) {
    throw new Error("`zig env` output did not contain a parseable `.std_dir` value.");
  }

  let stdDir: unknown;
  try {
    stdDir = JSON.parse(match[1]) as unknown;
  } catch {
    throw new Error("Could not parse the `.std_dir` string returned by `zig env`.");
  }
  if (typeof stdDir !== "string" || !isAbsolute(stdDir)) {
    throw new Error("`zig env` returned a non-absolute `.std_dir` path.");
  }
  return stdDir;
}

function commandOutput(command: string, result: ZigEnvResult): string {
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
    throw new Error(`\`${command}\` failed with exit code ${result.code}: ${detail}`);
  }
  return result.stdout.trim();
}

function createZigStdlibSearchTool(exec: ExtensionAPI["exec"]) {
  const zigStdlibSearchTool = defineTool({
  name: "zig-stdlib-search",
  label: "Zig Stdlib Search",
  description:
    "Search the standard library shipped with the Zig compiler selected in the current project. Use for unfamiliar or version-sensitive standard-library APIs. Reports the Zig version and source path; requires pi-fff's ffgrep tool.",
  parameters: Type.Object({
    query: Type.String({
      description: "Focused identifier or literal text to search for in the Zig standard library.",
    }),
    context: Type.Optional(
      Type.Number({ description: "Context lines around each match (default: 3)." }),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Maximum number of matches to return (default: 25)." }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    if (!ctx.tools.some((tool) => tool.name === "ffgrep")) {
      throw new Error("Required pi-fff tool `ffgrep` is not available in this Pi session.");
    }

    const versionResult = await exec("zig", ["version"], {
      cwd: ctx.cwd,
      signal,
      timeout: 10_000,
    });
    const zigVersion = commandOutput("zig version", versionResult);
    if (!zigVersion) throw new Error("`zig version` returned no version.");

    const envResult = await exec("zig", ["env"], {
      cwd: ctx.cwd,
      signal,
      timeout: 10_000,
    });
    const stdDir = parseZigStdDir(commandOutput("zig env", envResult));

    const outcome = await ctx.executeTool(
      "ffgrep",
      {
        pattern: params.query,
        path: stdDir,
        context: params.context ?? 3,
        limit: params.limit ?? 25,
      },
      { signal },
    );
    const resultText = outcome.result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    if (outcome.isError) {
      throw new Error(`pi-fff ffgrep failed: ${resultText || "no diagnostic output"}`);
    }

    return {
      content: [
        {
          type: "text",
          text: `Zig ${zigVersion} standard library (${stdDir})\n\n${resultText || "No matches returned."}`,
        },
      ],
      details: {
        query: params.query,
        zigVersion,
        stdDir,
      },
    };
  },
  });
  return zigStdlibSearchTool;
}

export default function zigStdlibSearchExtension(pi: ExtensionAPI): void {
  const zigStdlibSearchTool = createZigStdlibSearchTool(pi.exec.bind(pi));
  pi.registerTool(zigStdlibSearchTool);
  // /tree restores the active tools from the selected branch, which may predate
  // this extension. Honor an explicit defaultTools opt-in again before a request.
  // CLI exclusions remove the tool from the registry, so do not bypass them.
  pi.on("before_agent_start", () => {
    const name = zigStdlibSearchTool.name;
    let optedIn = false;
    for (const selection of pi.getSettings().defaultTools ?? []) {
      if (selection === name || selection === `+${name}`) optedIn = true;
      if (selection === `-${name}`) optedIn = false;
    }
    if (!optedIn || !pi.getAllTools().some((tool) => tool.name === name)) return;
    const active = pi.getActiveTools();
    if (!active.includes(name)) pi.setActiveTools([...active, name]);
  });
}
