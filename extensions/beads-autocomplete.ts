import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

interface BeadTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
}

interface BeadsIssueRecord {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  priority?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIssue(value: unknown): BeadTask | undefined {
  if (!isRecord(value)) return undefined;
  const issue = value as BeadsIssueRecord;
  if (
    typeof issue.id !== "string" ||
    typeof issue.title !== "string" ||
    typeof issue.status !== "string"
  ) {
    return undefined;
  }

  const priority = typeof issue.priority === "number" || typeof issue.priority === "string"
    ? String(issue.priority)
    : undefined;

  return {
    id: issue.id,
    title: issue.title,
    status: issue.status,
    priority: priority ? (priority.startsWith("P") ? priority : `P${priority}`) : undefined,
  };
}

export function parseBeadsList(stdout: string): BeadTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }

  const issues = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.issues)
      ? parsed.issues
      : [];

  return issues.flatMap((issue) => {
    const task = parseIssue(issue);
    return task ? [task] : [];
  });
}

export function filterBeadsTasks(tasks: BeadTask[], query: string): BeadTask[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return tasks.slice(0, 50);

  return tasks
    .map((task) => {
      const id = task.id.toLocaleLowerCase();
      const title = task.title.toLocaleLowerCase();
      const status = task.status.toLocaleLowerCase();
      const score = id === normalizedQuery
        ? 0
        : id.startsWith(normalizedQuery)
          ? 1
          : title.startsWith(normalizedQuery)
            ? 2
            : id.includes(normalizedQuery) || title.includes(normalizedQuery) || status.includes(normalizedQuery)
              ? 3
              : Number.POSITIVE_INFINITY;
      return { task, score };
    })
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score)
    .slice(0, 50)
    .map(({ task }) => task);
}

export function createBeadsAutocompleteProvider(
  current: AutocompleteProvider,
  getTasks: () => BeadTask[],
  waitForInitialLoad: () => Promise<void>,
): AutocompleteProvider {
  return {
    triggerCharacters: [":"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[\s])bd:([^\s]*)$/i);
      if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      await waitForInitialLoad();
      const query = match[1] ?? "";
      const tasks = filterBeadsTasks(getTasks(), query);
      const items: AutocompleteItem[] = tasks.map((task) => ({
        value: task.id,
        label: task.id,
        description: `${task.status}${task.priority ? ` · ${task.priority}` : ""} · ${task.title}`,
      }));

      return { prefix: `bd:${query}`, items };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function beadsAutocompleteExtension(pi: ExtensionAPI): void {
  let tasks: BeadTask[] = [];
  let activeCwd = "";
  let initialLoad: Promise<void> = Promise.resolve();
  let loadGeneration = 0;

  async function refresh(cwd: string): Promise<boolean> {
    const generation = ++loadGeneration;
    const result = await pi.exec(
      "bd",
      ["list", "--status", "open,in_progress,blocked,deferred", "--sort", "priority", "--limit", "200", "--flat", "--json", "--no-pager"],
      { cwd, timeout: 5000 },
    );
    if (result.code !== 0) return false;

    const loadedTasks = parseBeadsList(result.stdout);
    if (cwd === activeCwd && generation === loadGeneration) tasks = loadedTasks;
    return true;
  }

  pi.registerCommand("beads-tasks-refresh", {
    description: "Refresh Beads task autocomplete",
    handler: async (_args, ctx) => {
      const ok = await refresh(ctx.cwd);
      if (ok) {
        ctx.ui.notify(`Loaded ${tasks.length} Beads tasks.`, "info");
      } else {
        ctx.ui.notify("Could not load Beads tasks in this directory.", "warning");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeCwd = ctx.cwd;
    tasks = [];
    initialLoad = refresh(ctx.cwd).then(() => undefined).catch(() => undefined);
    ctx.ui.addAutocompleteProvider((current) =>
      createBeadsAutocompleteProvider(current, () => tasks, () => initialLoad),
    );
  });
}
