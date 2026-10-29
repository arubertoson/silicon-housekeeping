import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	type AgentSession,
	type ExtensionAPI,
	type InlineExtension,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

// Settings is not re-exported from the package root in Pi 1.4.0.
type Settings = ReturnType<ExtensionAPI["getSettings"]>;

// Reachability functions belong to the extension instance, just like execute handlers.
// Compare their presence, not their identity, when verifying a reconstructed contract.
type ToolContract = Omit<ToolInfo, "reachesTools"> & { hasReachability: boolean };

/** Immutable-by-ownership configuration captured once before a batch starts. */
export interface SubagentToolSetup {
	settings: Settings;
	tools: ToolContract[];
	activeTools: string[];
	projectTrusted: boolean;
	mcpServers: ReturnType<ExtensionAPI["getMcpServers"]>;
}

function toolContract({ reachesTools, ...tool }: ToolInfo): ToolContract {
	return { ...structuredClone(tool), hasReachability: reachesTools !== undefined };
}

/**
 * Capture data only; never retain parent-bound extension handlers.
 * @param excluded Tool names children must never inherit, e.g. the delegating
 *     tool itself, so delegation cannot recurse.
 */
export function captureSubagentTools(pi: ExtensionAPI, projectTrusted: boolean, excluded: readonly string[] = []): SubagentToolSetup {
	return {
		settings: structuredClone(pi.getSettings()),
		tools: pi.getAllTools().filter((tool) => !excluded.includes(tool.name)).map(toolContract),
		activeTools: pi.getActiveTools().filter((name) => !excluded.includes(name)),
		projectTrusted,
		mcpServers: structuredClone(pi.getMcpServers()),
	};
}

const BUILTIN_FACTORIES = {
	codemode: createCodemodeExtension,
	tool_search: createToolSearchExtension,
	mcp: createMcpExtension,
};
const CORE_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);

/** A frozen registry boundary, independent of model-visible declarations. */
export function selectSubagentTools(setup: SubagentToolSetup, requested?: string[]) {
	const registered = new Set(setup.tools.map((tool) => tool.name));
	if (requested !== undefined) {
		const unknown = requested.filter((name) => !registered.has(name) || name.includes("*") || /^[+-]/.test(name));
		if (unknown.length) throw new Error(`Unknown child tools: ${unknown.map((name) => JSON.stringify(name)).join(", ")}. Use exact registered tool names.`);
	}
	const names = [...new Set(requested ?? setup.tools.map((tool) => tool.name))];
	const selected = new Set(names);
	const expected = setup.tools.filter((tool) => selected.has(tool.name));
	const active = requested === undefined ? setup.activeTools.slice() : names;
	const callable = expected.filter((tool) => tool.exposure === "codemode" || tool.exposure === "deferred" ||
		(tool.exposure === "direct" && active.includes(tool.name))).map((tool) => tool.name);
	const activatable = new Set([...active, ...callable.filter((name) => {
		const exposure = expected.find((tool) => tool.name === name)?.exposure;
		return exposure === "codemode" || exposure === "deferred";
	})]);
	return {
		names, expected, active, callable, activatable,
		// Pi normally exempts MCP from --tools. Close that exemption even when
		// this snapshot/selection contains no MCP names; it also covers late tools.
		excludeTools: names.some((name) => name.startsWith("mcp__")) ? undefined : ["mcp__*"],
	};
}

/** Reconstruct only source-backed capabilities; no implicit extension discovery. */
export function subagentExtensionSources(setup: SubagentToolSetup, selected: ReturnType<typeof selectSubagentTools>) {
	const paths = new Set<string>();
	const factories: InlineExtension[] = [];
	const builtinNames = new Set<string>();
	for (const tool of selected.expected) {
		const source = tool.sourceInfo.path;
		if (source.startsWith("builtin:")) {
			const name = source.slice("builtin:".length);
			if (name in BUILTIN_FACTORIES) {
				builtinNames.add(name);
			} else if (!CORE_TOOLS.has(name)) {
				throw new Error(`Cannot reconstruct child tool ${JSON.stringify(tool.name)} from ${source}.`);
			}
		} else if (isAbsolute(source)) {
			paths.add(source);
		} else {
			throw new Error(`Cannot reconstruct child tool ${JSON.stringify(tool.name)} from ${source}: a loadable extension source is required.`);
		}
	}
	for (const [name, factory] of Object.entries(BUILTIN_FACTORIES)) {
		if (!builtinNames.has(name)) continue;
		paths.add(`builtin:${name}`);
		factories.push({ name, factory: factory(), builtin: true });
	}
	if (builtinNames.has("mcp") && setup.mcpServers.length) {
		factories.push((pi) => {
			// Let reconstructed sources retain ownership of startup registrations.
			pi.on("session_start", () => {
				for (const { name, config } of setup.mcpServers) {
					const existing = pi.getMcpServers().find((server) => server.name === name);
					if (!existing) pi.registerMcpServer(name, structuredClone(config));
					else if (!isDeepStrictEqual(existing.config, config)) throw new Error(`MCP server configuration differs: ${name}`);
				}
			});
		});
	}
	// Source order matters when multiple extensions register the same tool.
	// ToolInfo order records the winning tools; contracts below detect drift.
	return { paths: [...paths], factories };
}

/** Install in the child, after reconstructed factories, as defense in depth. */
export function subagentToolBoundary(selected: Pick<ReturnType<typeof selectSubagentTools>, "callable" | "activatable">): InlineExtension {
	return (pi) => {
		const callable = new Set(selected.callable);
		pi.on("tool_call", (event) => {
			const allowed = event.parentToolCallId ? callable : selected.activatable;
			if (!allowed.has(event.toolName)) return { block: true, reason: `Tool ${event.toolName} is outside this child's tool selection.` };
		});
		// Startup/late-registration hooks can activate tools independently of defaults,
		// including auto-enabling codemode. Preserve the requested capability boundary.
		const constrain = () => {
			const active = pi.getActiveTools();
			const kept = active.filter((name) => selected.activatable.has(name));
			if (kept.length !== active.length) pi.setActiveTools(kept);
		};
		pi.on("before_agent_start", constrain);
		pi.on("turn_start", constrain);
		// Execution enforcement is in tool_call, whose block result is fail-closed.
		// Errors in notification/request hooks alone do not prevent execution in Pi.
	};
}

/** MCP registers asynchronously after session_start; bound readiness, not agent settlement. */
export async function waitForSubagentMcpTools(
	child: AgentSession,
	selected: ReturnType<typeof selectSubagentTools>,
	signal?: AbortSignal,
): Promise<void> {
	const expected = selected.expected.filter((tool) => tool.sourceInfo.path === "builtin:mcp");
	if (!expected.length) return;
	const deadline = Date.now() + 30_000;
	while (expected.some((tool) => !child.getAllTools().some((candidate) => candidate.name === tool.name))) {
		signal?.throwIfAborted();
		if (Date.now() >= deadline) throw new Error(`Timed out reconstructing MCP tools: ${expected.map((tool) => tool.name).join(", ")}`);
		await delay(25, undefined, { signal });
	}
}

/** Verify provenance separately from portable tool contracts. No handler equality claims. */
export function verifySubagentTools(child: AgentSession, selected: ReturnType<typeof selectSubagentTools>): void {
	const actual = new Map(child.getAllTools().map((tool) => [tool.name, toolContract(tool)]));
	const errors: string[] = [];
	for (const expected of selected.expected) {
		const found = actual.get(expected.name);
		if (!found) {
			errors.push(`${expected.name}: missing (source ${expected.sourceInfo.path})`);
			continue;
		}
		const { sourceInfo: expectedSource, ...expectedContract } = expected;
		const { sourceInfo: actualSource, ...actualContract } = found;
		if (expectedSource.path !== actualSource.path || !isDeepStrictEqual(expectedContract, actualContract)) {
			errors.push(`${expected.name}: contract/source differs (${expectedSource.path} -> ${actualSource.path})`);
		}
	}
	const extra = [...actual.keys()].filter((name) => !selected.names.includes(name));
	if (extra.length) errors.push(`unexpected tools: ${extra.join(", ")}`);
	const active = child.getActiveToolNames();
	if (!isDeepStrictEqual(active, selected.active)) errors.push(`active loadout differs: ${active.join(", ")}`);
	const callable = child.getCallableToolNames().slice().sort();
	if (!isDeepStrictEqual(callable, selected.callable.slice().sort())) errors.push(`callable loadout differs: ${callable.join(", ")}`);
	if (errors.length) throw new Error(`Cannot reconstruct parent tool setup:\n${errors.join("\n")}`);
}
