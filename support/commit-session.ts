import { isDeepStrictEqual } from "node:util";
import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

function toolContract({ sourceInfo: _source, reachesTools: _reachesTools, ...tool }: ToolInfo) {
	return structuredClone(tool);
}

/** Clone storage and runtime, never the parent's mutable Agent or extension instances. */
export async function createCommitSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	options: { agentDir?: string; signal?: AbortSignal } = {},
): Promise<AgentSession> {
	if (!ctx.model) throw new Error("Select a model before /commit.");
	const model = structuredClone(ctx.model);
	const promptOptions = structuredClone(ctx.getSystemPromptOptions());
	const systemPrompt = ctx.getSystemPrompt();
	const activeTools = pi.getActiveTools().slice();
	const allTools = pi.getAllTools();
	const settings = structuredClone(pi.getSettings());
	const agentDir = options.agentDir ?? getAgentDir();
	const manager = SessionManager.inMemory(ctx.cwd);
	// New header/identity; retain entry ids, compaction checkpoints, edits and signatures.
	const sessionManager = SessionManager.inMemory(ctx.cwd, undefined, [
		manager.getHeader()!,
		...structuredClone(ctx.sessionManager.getBranch()),
	]);
	const prefix = structuredClone(sessionManager.buildSessionContext().messages);
	const settingsManager = SettingsManager.inMemory({
		...settings,
		compaction: { ...settings.compaction, enabled: false },
		cacheWarming: "off",
	});
	settingsManager.setProjectTrusted(ctx.isProjectTrusted());
	options.signal?.throwIfAborted();
	const builtinFactories = {
		codemode: createCodemodeExtension,
		tool_search: createToolSearchExtension,
		mcp: createMcpExtension,
	};
	const sources = new Set([
		...allTools.map((tool) => tool.sourceInfo.path),
		...pi.getCommands().filter((command) => command.source === "extension").map((command) => command.sourceInfo.path),
	]);
	const resourceLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [...sources].filter((path) => !path.startsWith("builtin:") && !path.startsWith("<")),
		extensionFactories: [
			...Object.entries(builtinFactories)
				.filter(([name]) => sources.has(`builtin:${name}`))
				.map(([name, factory]) => ({ name, factory: factory(), builtin: true })),
			(scratchPi) => {
				scratchPi.on("before_agent_start", (event) => {
					Object.assign(event.systemPromptOptions, structuredClone(promptOptions), { selectedTools: activeTools.slice() });
				});
			},
		],
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		skillsOverride: () => ({ skills: promptOptions.skills ?? [], diagnostics: [] }),
		agentsFilesOverride: () => ({ agentsFiles: promptOptions.contextFiles ?? [] }),
	});
	await resourceLoader.reload();
	options.signal?.throwIfAborted();
	const errors = resourceLoader.getExtensions().errors;
	if (errors.length) throw new Error(errors.map(({ path, error }) => `${path}: ${error}`).join("\n"));

	// Keep provider registrations local. Requests still use the parent's configured registry
	// (including runtime credentials/custom providers), not a second credential configuration.
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
	});
	const getModel = runtime.getModel.bind(runtime);
	runtime.getModel = (provider, id) => provider === model.provider && id === model.id ? model : getModel(provider, id);
	const hasAuth = runtime.hasConfiguredAuth.bind(runtime);
	runtime.hasConfiguredAuth = (provider) => provider === model.provider ? ctx.modelRegistry.hasConfiguredAuth(model) : hasAuth(provider);
	let session: AgentSession | undefined;
	let lowestThinking: AgentSession["thinkingLevel"] = "off";
	runtime.streamSimple = (requestModel, context, requestOptions) => {
		options.signal?.throwIfAborted();
		if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Parent work started; commit stopped.");
		if (requestModel.provider !== model.provider || requestModel.id !== model.id) {
			throw new Error("The commit session attempted to change models; stopped.");
		}
		if (session?.systemPrompt !== systemPrompt) {
			throw new Error("Cannot reconstruct the effective parent system prompt; commit stopped.");
		}
		// SSE shares cache routing affinity without acquiring/resetting the parent's WebSocket.
		// Disposal uses the scratch identity, never this request-local parent routing id.
		return ctx.modelRegistry.streamSimple(model, context, {
			...requestOptions, reasoning: lowestThinking === "off" ? undefined : lowestThinking,
			sessionId: ctx.sessionManager.getSessionId(), transport: "sse",
			signal: options.signal && requestOptions?.signal
				? AbortSignal.any([options.signal, requestOptions.signal])
				: options.signal ?? requestOptions?.signal,
		});
	};
	try {
		({ session } = await createAgentSession({
			cwd: ctx.cwd, agentDir, modelRuntime: runtime, model,
			thinkingLevel: "off", settingsManager, sessionManager, resourceLoader,
			// Keep registered hidden/codemode tools too; select the live loadout after startup.
			tools: allTools.map((tool) => tool.name),
		}));
		await session.bindExtensions({ mode: "print", onError: ({ extensionPath, event, error }) => {
			throw new Error(`Commit session extension failed (${extensionPath}, ${event}): ${error}`);
		} });
		if (!isDeepStrictEqual(prefix, sessionManager.buildSessionContext().messages)) {
			throw new Error("Extension startup changed the cloned conversation prefix; commit stopped.");
		}
		options.signal?.throwIfAborted();
		session.setThinkingLevel("off");
		lowestThinking = session.thinkingLevel;
		session.setActiveToolsByName(activeTools);
		const reconstructed = session.getAllTools();
		if (!isDeepStrictEqual(activeTools, session.getActiveToolNames()) ||
			!isDeepStrictEqual(allTools.map(toolContract).sort((a, b) => a.name.localeCompare(b.name)),
				reconstructed.map(toolContract).sort((a, b) => a.name.localeCompare(b.name)))) {
			throw new Error("Cannot reconstruct the parent tool registry/loadout; commit stopped.");
		}
		// The final inline hook applies the snapshot after reloaded hooks. Runtime-only
		// extension state is not cloneable through the SDK; declarations are checked above.
		return session;
	} catch (error) {
		if (session) await disposeCommitSession(session);
		throw error;
	}
}

export async function disposeCommitSession(session: AgentSession) {
	try {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}
