import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SplitRequest =
	| { kind: "fresh"; prompt?: string }
	| { kind: "fork"; prompt?: string }
	| { kind: "session"; sessionFile: string; prompt?: string };

export type SplitResult =
	| { status: "launched"; pane: string; sessionFile?: string }
	| { status: "refused"; message: string; sessionFile?: string }
	| { status: "uncertain"; message: string; sessionFile?: string };

type SplitLauncher = (request: SplitRequest, ctx: ExtensionContext) => Promise<SplitResult>;

/** @internal Synchronous service lookup on Pi's shared extension event bus. */
export const SPLIT_CHANNEL = "silicon-housekeeping:split";

/**
 * Open a child beside interactive Pi in tmux. Requires extensions/split.ts to be
 * loaded. Import this helper, not the extension factory; no launcher code or
 * module-global service state is copied into the caller.
 *
 * Example from another extension's command handler:
 *   const result = await requestSplit(pi, ctx, {
 *     kind: "session", sessionFile: preparedSessionFile,
 *   });
 *
 * All modes use ctx.cwd. Fresh starts an empty conversation. Fork captures the
 * current source leaf before any await. Session opens an existing file directly;
 * relative paths resolve from ctx.cwd. The caller must finish preparing a valid
 * Pi session before calling. The launcher never rewrites or deletes that file.
 * The child Pi owns subsequent writes to it. The active parent file is refused.
 *
 * No parent session switch, messages, editor changes, or UI notices occur here.
 * "launched" confirms the pane, not child readiness. "refused" means no launch
 * occurred, including busy, stale ownership, and a missing split extension.
 * "uncertain" means a launch may have occurred: do not retry automatically.
 * sessionFile identifies a retained child file when known; fresh has no known
 * file yet. Only launcher-created forks are cleaned up, and only before launch
 * or after explicit refusal. Potentially launched forks are always retained.
 *
 * Call with a current context. Callers that prepare data across awaits must
 * check their own session ownership before calling and before changing any
 * caller-owned state after this promise settles. No launch is retried here.
 */
export function requestSplit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: SplitRequest,
): Promise<SplitResult> {
	let launch: SplitLauncher | undefined;
	try {
		// emit dispatches synchronously but does not await handlers. Look up the
		// service synchronously, then await its ordinary promise outside the bus.
		pi.events.emit(SPLIT_CHANNEL, (candidate: SplitLauncher) => { launch ??= candidate; });
	} catch (error) {
		return Promise.resolve({ status: "refused", message: error instanceof Error ? error.message : String(error) });
	}
	if (!launch) {
		return Promise.resolve({ status: "refused", message: "The split extension is not loaded." });
	}
	return launch(request, ctx);
}
