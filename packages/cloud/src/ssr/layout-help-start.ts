import { HELP_VIEW_LIMIT, type HelpKind } from "../shared/help";
import { SHELL_SHORTCUT_ORDER } from "./shell-shortcuts";

/** The concept asks for at most eight tasks as tiles; more task articles follow as a list. */
export const HELP_START_TILE_LIMIT = 8;
/** "For this view" shows two or three articles the page names. */
export { HELP_VIEW_LIMIT } from "../shared/help";
export const HELP_START_GROUP_KINDS = ["start", "reference", "troubleshoot"] as const;
export type HelpStartGroupKind = (typeof HELP_START_GROUP_KINDS)[number];
export type HelpStartTopic = { id: string; title: string; order?: number; kind?: HelpKind };
export type HelpStart<T> = {
  /** Declared ids in declared order: only ids of known topics, without duplicates, at most HELP_VIEW_LIMIT. */
  view: T[];
  /** Articles of kind task (missing kind = task), by order (missing = 100) then title, at most HELP_START_TILE_LIMIT. */
  tiles: T[];
  /** The remaining task articles in the same order, so no task becomes unreachable. */
  moreTasks: T[];
  /** Fixed order start, reference, troubleshoot; a kind without articles is absent. Each list sorted like tiles. */
  groups: { kind: HelpStartGroupKind; topics: T[] }[];
};

export const helpStart = <T extends HelpStartTopic>(topics: readonly T[], viewIds: readonly string[] = []): HelpStart<T> => {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const view = [...new Set(viewIds)]
    .flatMap((id) => {
      const topic = byId.get(id);
      return topic ? [topic] : [];
    })
    .slice(0, HELP_VIEW_LIMIT);
  const sorted = [...topics].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  const tasks = sorted.filter((topic) => (topic.kind ?? "task") === "task");
  return {
    view,
    tiles: tasks.slice(0, HELP_START_TILE_LIMIT),
    moreTasks: tasks.slice(HELP_START_TILE_LIMIT),
    groups: HELP_START_GROUP_KINDS.flatMap((kind) => {
      const topics = sorted.filter((topic) => topic.kind === kind);
      return topics.length ? [{ kind, topics }] : [];
    }),
  };
};

export type HelpShortcutScope = "everywhere" | "app" | "selection";
export type HelpShortcutCommand = { id: string; title: string; description?: string; shortcut?: string; scope?: "selection" | "page" };
/**
 * Group commands with a shortcut: scope "selection" -> "selection"; id starting with "cloud." -> "everywhere"; the rest -> "app".
 * Group order everywhere, app, selection; empty groups are absent. Inside "everywhere", the ids of SHELL_SHORTCUT_ORDER come first in that
 * order (so rows rendered on the server keep their place when the browser adds more), then the rest in input order; other groups keep input order.
 * Commands without a shortcut are dropped.
 */
export const helpShortcutGroups = <T extends HelpShortcutCommand>(
  commands: readonly T[],
): { scope: HelpShortcutScope; shortcuts: (T & { shortcut: string })[] }[] => {
  const groups: Record<HelpShortcutScope, (T & { shortcut: string })[]> = { everywhere: [], app: [], selection: [] };
  for (const command of commands) {
    if (!command.shortcut) continue;
    const scope = command.scope === "selection" ? "selection" : command.id.startsWith("cloud.") ? "everywhere" : "app";
    groups[scope].push({ ...command, shortcut: command.shortcut });
  }
  const rank = (id: string) => {
    const index = SHELL_SHORTCUT_ORDER.findIndex((shellId) => shellId === id);
    return index < 0 ? SHELL_SHORTCUT_ORDER.length : index;
  };
  groups.everywhere.sort((a, b) => rank(a.id) - rank(b.id));
  return (["everywhere", "app", "selection"] as const).flatMap((scope) =>
    groups[scope].length ? [{ scope, shortcuts: groups[scope] }] : [],
  );
};
