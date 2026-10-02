import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

export type ReviewTarget =
	| { type: "uncommitted" }
	| { type: "baseBranch"; branch: string; to?: string }
	| { type: "commit"; sha: string; title?: string }
	| { type: "pullRequest"; prNumber: number; baseBranch: string; baseRevision: string; title: string }
	| { type: "folder"; paths: string[] };

export type ReviewRepository = { kind: "git" | "jj"; cwd: string; root: string };
export type ReviewPlan = {
	repo: ReviewRepository;
	target: ReviewTarget;
	commands: string[];
	baseline?: string;
	tip?: string;
	workingRevision?: string;
	workingChange?: string;
};

type Revision = { commit: string; change?: string };
const JJ_OPTIONS = ["--no-pager", "--color", "never"];

async function exec(pi: ExtensionAPI, repo: Pick<ReviewRepository, "cwd">, command: string, args: string[]) {
	const result = await pi.exec(command, command === "jj" ? [...JJ_OPTIONS, ...args] : args, { cwd: repo.cwd });
	if (result.code !== 0 || result.killed) {
		throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
	}
	return result.stdout;
}

async function exists(filename: string): Promise<boolean> {
	try {
		await fs.lstat(filename);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
			return false;
		throw error;
	}
}

// Choose the nearest repository boundary, with jj taking precedence at the same
// boundary. A nested Git repository must not accidentally review its jj parent.
export async function detectReviewRepository(pi: ExtensionAPI, cwd: string): Promise<ReviewRepository> {
	let dir = path.resolve(cwd);
	while (true) {
		if (await exists(path.join(dir, ".jj"))) {
			const root = (await exec(pi, { cwd }, "jj", ["--ignore-working-copy", "root"])).trim();
			// `jj root` alone also succeeds for an incomplete .jj directory.
			await exec(pi, { cwd }, "jj", ["--ignore-working-copy", "log", "--no-graph", "-r", "@", "-T", "commit_id"]);
			return { kind: "jj", cwd, root };
		}
		if (await exists(path.join(dir, ".git"))) {
			const root = (await exec(pi, { cwd }, "git", ["rev-parse", "--show-toplevel"])).trim();
			return { kind: "git", cwd, root };
		}
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error("Not a Git or jj repository");
		dir = parent;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function inspectionCommand(repo: ReviewRepository, args: string[]): string {
	const prefix =
		repo.kind === "jj" ? ["jj", "--no-pager", "--color", "never", "--repository", repo.root] : ["git", "-C", repo.root];
	return [...prefix, ...args].map(shellQuote).join(" ");
}

async function resolveRevision(pi: ExtensionAPI, repo: ReviewRepository, expression: string): Promise<Revision> {
	if (repo.kind === "git") {
		const commit = (
			await exec(pi, repo, "git", ["rev-parse", "--verify", "--end-of-options", `${expression}^{commit}`])
		).trim();
		if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`Invalid commit: ${expression}`);
		return { commit };
	}
	const output = (
		await exec(pi, repo, "jj", [
			"log",
			"--no-graph",
			"-r",
			`exactly((${expression}), 1)`,
			"-T",
			'commit_id ++ "\\t" ++ change_id ++ "\\t" ++ conflict ++ "\\n"',
		])
	).trim();
	const [commit, change, conflict] = output.split("\t");
	if (!/^[0-9a-f]{40,64}$/.test(commit) || !/^[k-z]+$/.test(change) || !["true", "false"].includes(conflict)) {
		throw new Error(`Expected exactly one jj revision: ${expression}`);
	}
	if (conflict === "true") throw new Error(`Resolve conflicts in ${expression} before reviewing`);
	return { commit, change };
}

export async function getLocalBranches(pi: ExtensionAPI, repo: ReviewRepository): Promise<string[]> {
	const output =
		repo.kind === "jj"
			? await exec(pi, repo, "jj", [
					"bookmark",
					"list",
					"--all-remotes",
					"-T",
					'if(present && !conflict, name ++ if(remote, "@" ++ remote) ++ "\\n")',
				])
			: await exec(pi, repo, "git", [
					"for-each-ref",
					"--format=%(refname:short)%09%(symref)",
					"refs/heads",
					"refs/remotes",
				]);
	return output
		.split("\n")
		.filter(Boolean)
		.filter((line) => !line.split("\t")[1])
		.map((line) => line.split("\t")[0])
		.filter((ref) => !ref.endsWith("@git"));
}

export async function getRecentCommits(
	pi: ExtensionAPI,
	repo: ReviewRepository,
	limit = 10,
): Promise<Array<{ sha: string; title: string }>> {
	if (repo.kind === "jj") {
		const output = await exec(pi, repo, "jj", [
			"log",
			"--no-graph",
			"-r",
			"::@ ~ root()",
			"-n",
			String(limit),
			"-T",
			'commit_id ++ "\\t" ++ description.first_line().escape_json() ++ "\\n"',
		]);
		return output
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [sha, title] = line.split("\t");
				return { sha, title: JSON.parse(title) };
			});
	}
	const output = await exec(pi, repo, "git", ["log", "--format=%H%x09%s", "-n", String(limit)]);
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf("\t");
			return { sha: line.slice(0, tab), title: line.slice(tab + 1) };
		});
}

export async function hasUncommittedChanges(pi: ExtensionAPI, repo: ReviewRepository): Promise<boolean> {
	if (repo.kind === "jj") {
		const empty = (await exec(pi, repo, "jj", ["log", "--no-graph", "-r", "@", "-T", "empty"])).trim();
		if (empty !== "true" && empty !== "false")
			throw new Error("Could not determine whether the jj working change is empty");
		return empty === "false";
	}
	return (await exec(pi, repo, "git", ["status", "--porcelain"])).trim().length > 0;
}

export async function getCurrentBranch(pi: ExtensionAPI, repo: ReviewRepository): Promise<string | null> {
	if (repo.kind === "jj") return null; // jj has no checked-out bookmark.
	return (await exec(pi, repo, "git", ["branch", "--show-current"])).trim() || null;
}

export async function getDefaultBranch(pi: ExtensionAPI, repo: ReviewRepository): Promise<string | null> {
	if (repo.kind === "jj") {
		const trunk = await resolveRevision(pi, repo, "trunk()");
		if (!/^0+$/.test(trunk.commit)) return "trunk()";
	} else {
		const result = await pi.exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
			cwd: repo.cwd,
		});
		if (result.code === 0 && result.stdout.trim()) return result.stdout.trim().replace(/^origin\//, "");
		if (result.code !== 1) throw new Error(`Could not resolve default branch: ${result.stderr.trim()}`);
	}
	const branches = await getLocalBranches(pi, repo);
	return (
		["main", "master", "main@origin", "master@origin", "origin/main", "origin/master"].find((name) =>
			branches.includes(name),
		) ?? null
	);
}

export async function hasFeatureStack(pi: ExtensionAPI, repo: ReviewRepository, base: string): Promise<boolean> {
	if (repo.kind === "git") {
		const branch = await getCurrentBranch(pi, repo);
		return branch !== null && branch !== base;
	}
	return (
		(
			await exec(pi, repo, "jj", ["log", "--no-graph", "-r", `(${base})..@ ~ empty()`, "-T", 'commit_id ++ "\\n"'])
		).trim().length > 0
	);
}

async function getMergeBase(pi: ExtensionAPI, repo: ReviewRepository, base: string, tip: string): Promise<string> {
	if (repo.kind === "jj") return (await resolveRevision(pi, repo, `fork_point(${base} | ${tip})`)).commit;
	const bases = (await exec(pi, repo, "git", ["merge-base", "--all", base, tip])).trim().split("\n").filter(Boolean);
	if (bases.length !== 1) throw new Error("Review requires exactly one merge base");
	return bases[0];
}

async function resolveBaseRevision(pi: ExtensionAPI, repo: ReviewRepository, target: Extract<ReviewTarget, { type: "baseBranch" | "pullRequest" }>): Promise<Revision> {
	if (target.type === "pullRequest") return resolveRevision(pi, repo, target.baseRevision);
	let expression = target.branch;
	// Match the existing Git convention of using the base's upstream when present.
	if (repo.kind === "git") {
		const upstream = await pi.exec("git", ["rev-parse", "--abbrev-ref", "--end-of-options", `${target.branch}@{upstream}`], { cwd: repo.cwd });
		if (upstream.code === 0 && upstream.stdout.trim()) expression = upstream.stdout.trim();
	}
	return resolveRevision(pi, repo, expression);
}

// Resolve scope before changing Pi session state. Explicit --to and commit reviews
// are snapshots; default stack/PR reviews include the working copy and later fixes.
export async function prepareReview(
	pi: ExtensionAPI,
	repo: ReviewRepository,
	target: ReviewTarget,
): Promise<ReviewPlan> {
	const plan: ReviewPlan = { repo, target, commands: [] };
	if (target.type === "folder") return plan;
	if (target.type === "commit") {
		plan.tip = (await resolveRevision(pi, repo, target.sha)).commit;
		plan.commands = [
			inspectionCommand(
				repo,
				repo.kind === "jj" ? ["diff", "--git", "-r", plan.tip] : ["show", "--format=fuller", "--patch", plan.tip],
			),
		];
		return plan;
	}

	if (repo.kind === "git" && !(target.type === "baseBranch" && target.to)) {
		if ((await exec(pi, repo, "git", ["ls-files", "--unmerged", "-z"])).length) {
			throw new Error("Resolve working-copy conflicts before reviewing");
		}
	}
	if (target.type === "uncommitted" && repo.kind === "git") {
		// An unborn Git branch can still have staged/untracked work to review.
		const head = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo.cwd });
		if (head.code === 0) plan.workingRevision = head.stdout.trim();
		else if (head.code !== 1) throw new Error(`Could not read Git HEAD: ${head.stderr.trim()}`);
		const format = (await exec(pi, repo, "git", ["rev-parse", "--show-object-format"])).trim();
		if (format !== "sha1" && format !== "sha256") throw new Error(`Unsupported Git object format: ${format}`);
		plan.baseline = plan.workingRevision ?? createHash(format).update("tree 0\0").digest("hex");
		plan.commands = [
			inspectionCommand(repo, ["status", "--porcelain"]),
			inspectionCommand(repo, ["diff"]),
			inspectionCommand(repo, ["diff", "--staged"]),
			inspectionCommand(repo, ["ls-files", "--others", "--exclude-standard"]),
		];
		return plan;
	}
	if (target.type === "baseBranch" && target.to) {
		plan.tip = (await resolveRevision(pi, repo, target.to)).commit;
		const base = await resolveBaseRevision(pi, repo, target);
		plan.baseline = await getMergeBase(pi, repo, base.commit, plan.tip);
		plan.commands = [
			inspectionCommand(
				repo,
				repo.kind === "jj"
					? ["diff", "--git", "--from", plan.baseline, "--to", plan.tip]
					: ["diff", plan.baseline, plan.tip],
			),
		];
		return plan;
	}
	const working = await resolveRevision(pi, repo, repo.kind === "jj" ? "@" : "HEAD");
	plan.workingRevision = working.commit;
	plan.workingChange = working.change;
	if (target.type === "uncommitted") {
		plan.commands = [inspectionCommand(repo, ["diff", "--git", "-r", "@"])];
		plan.commands.push(inspectionCommand(repo, ["status"]));
		return plan;
	}

	const base = await resolveBaseRevision(pi, repo, target);
	plan.baseline = await getMergeBase(pi, repo, base.commit, working.commit);
	plan.commands = [
		inspectionCommand(
			repo,
			repo.kind === "jj"
				? ["diff", "--git", "--from", plan.baseline, "--to", "@"]
				: ["diff", plan.baseline],
		),
	];
	if (repo.kind === "git") {
		plan.commands.push(inspectionCommand(repo, ["ls-files", "--others", "--exclude-standard"]));
	}
	if (repo.kind === "jj") plan.commands.push(inspectionCommand(repo, ["status"]));
	return plan;
}

export function isLoopCompatibleTarget(target: ReviewTarget): boolean {
	return target.type !== "commit" && !(target.type === "baseBranch" && target.to);
}

export async function buildReviewPrompt(
	pi: ExtensionAPI,
	plan: ReviewPlan,
	options?: { includeLocalChanges?: boolean },
): Promise<string> {
	const { repo, target } = plan;
	if (target.type === "folder") {
		return `Review the code in the following paths: ${target.paths.join(", ")}. This is a snapshot review (not a diff). Read the files directly in these paths and provide prioritized, actionable findings.`;
	}
	if (options?.includeLocalChanges && !isLoopCompatibleTarget(target))
		throw new Error("Loop fixing requires a working-copy review, not a commit or explicit --to snapshot");
	let commands = plan.commands;
	if (repo.kind === "jj" && !plan.tip) {
		const current = await resolveRevision(pi, repo, "@");
		// The initial logical working change must still lead to @. A new child is
		// fine; switching to unrelated work or abandoning it is not.
		if (!plan.workingChange) throw new Error("Review plan is missing its jj working change");
		const anchor = await resolveRevision(pi, repo, plan.workingChange);
		const ancestor = await resolveRevision(pi, repo, `fork_point(${anchor.commit} | ${current.commit})`);
		if (ancestor.commit !== anchor.commit)
			throw new Error("jj working copy switched away from the review target; start a new review");
		if (target.type === "uncommitted") {
			commands = [
				inspectionCommand(repo, ["diff", "--git", "-r", `${plan.workingChange}::@`]),
				inspectionCommand(repo, ["status"]),
			];
		}
	} else if (repo.kind === "git" && options?.includeLocalChanges && plan.workingRevision) {
		const result = await pi.exec("git", ["merge-base", "--is-ancestor", plan.workingRevision, "HEAD"], {
			cwd: repo.cwd,
		});
		if (result.code !== 0) throw new Error("Git checkout changed away from the review target; start a new review");
	}
	if (repo.kind === "git" && target.type === "uncommitted" && options?.includeLocalChanges) {
		if (!plan.baseline) throw new Error("Review plan is missing its Git baseline");
		commands = [
			inspectionCommand(repo, ["diff", plan.baseline]),
			inspectionCommand(repo, ["diff"]),
			inspectionCommand(repo, ["diff", "--staged"]),
			inspectionCommand(repo, ["status", "--porcelain"]),
			inspectionCommand(repo, ["ls-files", "--others", "--exclude-standard"]),
		];
	}
	if (repo.kind === "git" && options?.includeLocalChanges && (target.type === "baseBranch" || target.type === "pullRequest")) {
		commands = [...commands, inspectionCommand(repo, ["status", "--porcelain"]),
			inspectionCommand(repo, ["diff"]), inspectionCommand(repo, ["diff", "--staged"])];
	}
	let focus: string;
	switch (target.type) {
		case "uncommitted":
			focus = repo.kind === "jj"
				? "Review the current jj change, including newly tracked files and local fixes."
				: "Review the current code changes (staged, unstaged, and untracked files).";
			break;
		case "commit":
			focus = `Review only the changes introduced by revision ${target.sha}${target.title ? ` (${JSON.stringify(target.title)})` : ""}, resolved to ${plan.tip}.`;
			break;
		case "pullRequest":
			focus = `Review pull request #${target.prNumber} (${JSON.stringify(target.title)}) against '${target.baseBranch}'.`;
			break;
		case "baseBranch":
			focus = `Review the complete stack against base '${target.branch}'${target.to ? ` ending at '${target.to}' (snapshot; exclude unrelated working-copy changes)` : ", including working-copy changes"}.`;
			break;
	}
	const baseline = plan.baseline ? ` The comparison starts at ${target.type === "uncommitted" ? "the initial review baseline" : "merge base"} ${plan.baseline}.` : "";
	const local = !plan.tip ? " Read any untracked files listed by the commands too." : "";
	const snapshot = plan.tip
		? ` Read affected files from revision ${plan.tip}, not from an unrelated working copy (use ${repo.kind === "jj" ? "jj file show -r <revision> <path>" : "git show <revision>:<path>"}).`
		: "";
	return `${focus}${baseline} Use ${repo.kind}, not ${repo.kind === "jj" ? "Git" : "jj"}, to inspect this scope. Run:\n\n${commands.map((command) => `\`${command}\``).join("\n\n")}${local}${snapshot}\n\nProvide prioritized, actionable findings. Do not switch revisions, commit, squash, or rebase during the review.`;
}

export type PullRequestReference = { number: number; repository?: string };
export function parsePrReference(ref: string): PullRequestReference {
	const value = ref.trim();
	const number = value.match(/^#?([1-9]\d*)$/);
	if (number && Number.isSafeInteger(Number(number[1]))) return { number: Number(number[1]) };
	const url = value.match(/^(?:https:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/);
	if (url && Number.isSafeInteger(Number(url[3]))) return { number: Number(url[3]), repository: `${url[1]}/${url[2]}` };
	throw new Error("Invalid PR reference. Enter a number, #number, or GitHub PR URL.");
}

function repositoryFromRemote(url: string): string {
	const match = url.match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
	if (!match) throw new Error(`Cannot infer a GitHub repository from ${url}; use the PR URL`);
	return `${match[1]}/${match[2]}`;
}

async function ensureGitCheckoutSafe(pi: ExtensionAPI, repo: ReviewRepository): Promise<void> {
	const status = await exec(pi, repo, "git", ["status", "--porcelain"]);
	if (status.split("\n").some((line) => line && !line.startsWith("??"))) {
		throw new Error("Cannot checkout PR: you have uncommitted changes. Please commit or stash them first.");
	}
}

async function ensureCheckoutSafe(pi: ExtensionAPI, repo: ReviewRepository, head: string): Promise<void> {
	const jjFiles = async (revision: string) =>
		(await exec(pi, repo, "jj", ["file", "list", "-r", revision, "-T", 'json(path) ++ "\\n"']))
			.split("\n")
			.filter(Boolean)
			.map((line): string => JSON.parse(line));
	const tracked = new Set(
		repo.kind === "jj"
			? await jjFiles("@")
			: (await exec(pi, repo, "git", ["-C", repo.root, "ls-files", "-z"])).split("\0").filter(Boolean),
	);
	const incomingFiles =
		repo.kind === "jj"
			? await jjFiles(head)
			: (await exec(pi, repo, "git", ["ls-tree", "--full-tree", "-r", "--name-only", "-z", head]))
					.split("\0")
					.filter(Boolean);
	for (const incoming of incomingFiles) {
		let candidate = incoming;
		while (candidate !== ".") {
			if (!tracked.has(candidate)) {
				const filename = path.join(repo.root, candidate);
				if (await exists(filename)) {
					const stat = await fs.lstat(filename);
					if (candidate === incoming || !stat.isDirectory())
						throw new Error(`Cannot checkout PR: untracked or ignored path would be overwritten: ${candidate}`);
				}
			}
			candidate = path.dirname(candidate);
		}
	}
}

// gh provides identity/metadata; Git transports PR refs; jj owns its workspace.
// /end-review restores Pi conversation state only, just as on the Git path.
export async function checkoutPullRequest(
	pi: ExtensionAPI,
	repo: ReviewRepository,
	ref: string,
): Promise<ReviewTarget> {
	const reference = parsePrReference(ref);
	if (repo.kind === "git") await ensureGitCheckoutSafe(pi, repo);
	const backing =
		repo.kind === "jj"
			? (await exec(pi, repo, "jj", ["git", "root"])).trim()
			: (await exec(pi, repo, "git", ["rev-parse", "--absolute-git-dir"])).trim();
	let repository = reference.repository;
	const remotes = (await exec(pi, repo, "git", ["--git-dir", backing, "remote"])).trim().split("\n").filter(Boolean);
	const remoteUrl = async (name: string) => (await exec(pi, repo, "git", ["--git-dir", backing, "config", "--get", `remote.${name}.url`])).trim();
	if (!repository && repo.kind === "jj") {
		const defaultRemote = await pi.exec(
			"git",
			["--git-dir", backing, "config", "--get-regexp", "^remote\\..*\\.gh-resolved$"],
			{ cwd: repo.cwd },
		);
		if (defaultRemote.code !== 0 && defaultRemote.code !== 1)
			throw new Error(`Could not read gh default repository: ${defaultRemote.stderr.trim()}`);
		const selected = defaultRemote.stdout.trim().split("\n").filter(Boolean);
		if (selected.length > 1) throw new Error("Multiple gh default repositories configured; use the PR URL");
		if (selected.length === 1) {
			const match = selected[0].match(/^remote\.(.+)\.gh-resolved\s+(.+)$/);
			if (!match) throw new Error("Invalid gh default repository configuration; use the PR URL");
			repository = match[2] === "base" ? repositoryFromRemote(await remoteUrl(match[1])) : match[2].replace(/^github\.com\//, "");
		} else {
			// Match gh's non-interactive remote preference, including fork setups.
			const priority = (name: string) => ["upstream", "github", "origin"].indexOf(name);
			const sorted = [...remotes].sort((a, b) => (priority(a) < 0 ? 3 : priority(a)) - (priority(b) < 0 ? 3 : priority(b)));
			for (const remote of sorted) {
				const url = await remoteUrl(remote);
				if (/(?:github\.com[:/])/.test(url)) {
					repository = repositoryFromRemote(url);
					break;
				}
			}
			if (!repository) throw new Error("Cannot infer a GitHub repository; use the PR URL");
		}
	}
	const data = JSON.parse(
		await exec(pi, repo, "gh", [
			"pr",
			"view",
			String(reference.number),
			...(repository ? ["--repo", repository] : []),
			"--json",
			"number,url,title,baseRefName,baseRefOid,headRefName,headRefOid",
		]),
	);
	const canonical = parsePrReference(data.url);
	if (
		canonical.number !== reference.number ||
		!canonical.repository ||
		(repository && canonical.repository.toLowerCase() !== repository.toLowerCase()) ||
		typeof data.title !== "string" ||
		typeof data.baseRefName !== "string" ||
		!/^[0-9a-f]{40,64}$/.test(data.headRefOid) ||
		!/^[0-9a-f]{40,64}$/.test(data.baseRefOid)
	) {
		throw new Error("GitHub returned invalid or mismatched PR metadata");
	}
	repository = canonical.repository;
	await exec(pi, repo, "git", ["check-ref-format", `refs/heads/${data.baseRefName}`]);
	let source = `https://github.com/${repository}.git`;
	for (const remote of remotes) {
		const url = await remoteUrl(remote);
		// Prefer existing transport/auth configuration for the base repository.
		if (/(?:github\.com[:/])/.test(url) && repositoryFromRemote(url).toLowerCase() === repository.toLowerCase()) {
			source = remote;
			break;
		}
	}
	const namespace = `refs/heads/pi-review/${repository}/${reference.number}`;
	await exec(pi, repo, "git", [
		"--git-dir",
		backing,
		"fetch",
		"--no-tags",
		source,
		`+refs/pull/${reference.number}/head:${namespace}/head`,
		`+${data.baseRefOid}:${namespace}/base`,
	]);
	for (const [name, expected] of [
		["head", data.headRefOid],
		["base", data.baseRefOid],
	]) {
		const actual = (
			await exec(pi, repo, "git", ["--git-dir", backing, "rev-parse", "--verify", `${namespace}/${name}^{commit}`])
		).trim();
		if (actual !== expected) throw new Error("PR changed while fetching; retry /review");
	}
	if (repo.kind === "jj") {
		await exec(pi, repo, "jj", ["git", "import"]);
		await resolveRevision(pi, repo, data.headRefOid);
		await resolveRevision(pi, repo, data.baseRefOid);
		await ensureCheckoutSafe(pi, repo, data.headRefOid);
		await exec(pi, repo, "jj", ["new", data.headRefOid]);
	} else {
		await ensureGitCheckoutSafe(pi, repo);
		await ensureCheckoutSafe(pi, repo, data.headRefOid);
		await exec(pi, repo, "gh", ["pr", "checkout", String(reference.number), "--repo", repository]);
		const actual = await resolveRevision(pi, repo, "HEAD");
		if (actual.commit !== data.headRefOid)
			throw new Error("PR checkout does not match the fetched PR head; retry /review");
	}
	return {
		type: "pullRequest",
		prNumber: reference.number,
		baseBranch: data.baseRefName,
		baseRevision: data.baseRefOid,
		title: data.title,
	};
}

export type ParsedReviewArgs = {
	target: ReviewTarget | { type: "pr"; ref: string } | null;
	extraInstruction?: string;
	error?: string;
};

export function parseReviewArgs(value: string | undefined): ParsedReviewArgs {
	if (!value?.trim()) return { target: null };
	const tokens: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			if (char === "\\" && i + 1 < value.length) current += value[++i];
			else if (char === quote) quote = null;
			else current += char;
		} else if (char === '"' || char === "'") quote = char;
		else if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
		} else current += char;
	}
	if (quote) return { target: null, error: "Unclosed quote in /review arguments" };
	if (current) tokens.push(current);
	const parts: string[] = [];
	let extraInstruction: string | undefined;
	let to: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const flag = token.split("=", 1)[0];
		if (flag === "--extra" || flag === "--to") {
			const argument = token.includes("=") ? token.slice(token.indexOf("=") + 1) : tokens[++i];
			if (!argument || argument.startsWith("--")) return { target: null, error: `Missing value for ${flag}` };
			if (flag === "--extra") extraInstruction = argument;
			else to = argument;
		} else if (token.startsWith("--")) return { target: null, error: `Unknown option: ${token}` };
		else parts.push(token);
	}
	if (to && parts[0]?.toLowerCase() !== "branch")
		return { target: null, error: "--to is only supported with /review branch <base>" };
	if (!parts.length) return { target: null, extraInstruction };
	let target: ParsedReviewArgs["target"];
	switch (parts[0].toLowerCase()) {
		case "uncommitted":
			if (parts.length !== 1) return { target: null, error: "Usage: /review uncommitted" };
			target = { type: "uncommitted" };
			break;
		case "branch":
			if (parts.length !== 2) return { target: null, error: "Usage: /review branch <base> [--to <tip>]" };
			target = { type: "baseBranch", branch: parts[1], ...(to ? { to } : {}) };
			break;
		case "commit":
			if (!parts[1]) return { target: null, error: "Usage: /review commit <revision> [title]" };
			target = { type: "commit", sha: parts[1], title: parts.slice(2).join(" ") || undefined };
			break;
		case "folder":
			if (!parts[1]) return { target: null, error: "Usage: /review folder <paths...>" };
			target = { type: "folder", paths: parts.slice(1) };
			break;
		case "pr":
			if (parts.length !== 2) return { target: null, error: "Usage: /review pr <number or URL>" };
			target = { type: "pr", ref: parts[1] };
			break;
		default:
			return { target: null, error: `Unknown review mode: ${parts[0]}` };
	}
	return { target, extraInstruction };
}
