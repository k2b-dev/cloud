import { aiSkillFilePathFromMount } from "../file-mount";
import type { AiTurnBlock } from "../protocol";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";

type Tool = Extract<AiTurnBlock, { kind: "tool" }>;
type Text = Extract<AiTurnBlock, { kind: "text" }>;
export type AiWorkEntry = Exclude<AiTurnBlock, { kind: "text" } | { kind: "steer_message" }>;
/**
 * One row of the expanded work: an intermediate text, a step, or a group that folds housekeeping or repeated calls
 * on one target and opens in place.
 */
export type AiWorkItem =
  | { kind: "text"; block: Text }
  | { kind: "step"; entry: AiWorkEntry }
  | { kind: "housekeeping"; id: string; entries: AiWorkEntry[] }
  | { kind: "repeat"; id: string; target: string; entries: AiWorkEntry[] };

/** A failed call, including a code run that reported an error. A rejected approval is a decision, not a failure. */
export function isFailedTool(tool: Tool): boolean {
  if (tool.status === "rejected") return false;
  if (tool.isError || tool.status === "failed") return true;
  const result = tool.result;
  return (
    ["code_run", "code_inspect"].includes(tool.name) &&
    result !== null &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "error"
  );
}

const HOUSEKEEPING_TOOLS = new Set([
  "load_skill",
  "load_local_skill",
  "search_skills",
  "load_tools",
  "search_tools",
  "list_apps",
  "search_help",
  "read_help",
  "search_project",
  "read_project_knowledge",
]);

/** Preparation the reader rarely needs: loading tools, skills, and knowledge, and reading a loaded skill's files. */
export const isHousekeepingTool = (tool: Tool): boolean => {
  if (HOUSEKEEPING_TOOLS.has(tool.name)) return true;
  if (tool.name !== "read_file" && tool.name !== "list_files") return false;
  const path = tool.args !== null && typeof tool.args === "object" && "path" in tool.args ? tool.args.path : undefined;
  return typeof path === "string" && aiSkillFilePathFromMount(path.trim()) !== null;
};

const isStep = (entry: AiWorkEntry) => entry.kind === "tool" || entry.kind === "compaction";

/** The file, address, or query a folded row shows. A call without one never folds with others. */
const callTarget = (tool: Tool): string | undefined => {
  const args = isRecord(tool.args) ? tool.args : {};
  return [args.path, args.url, args.query].find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();
};

/** Arguments that page through one call's result, such as read_file's byte slices or an app's cursor and page size. */
const PAGING_ARGUMENTS = new Set(["offset", "length", "limit", "cursor", "after", "page", "pageSize"]);

type Fold = { kind: "housekeeping" } | { kind: "repeat"; name: string; target: string; identity: string };

/**
 * What a step folds with: housekeeping with housekeeping, a running or finished call with the same call apart from
 * paging, such as reading one file in parts. Repeated calls need a target; failed, rejected, and waiting calls never repeat.
 */
const foldOf = (tool: Tool): Fold | null => {
  if (isHousekeepingTool(tool)) return { kind: "housekeeping" };
  const target = callTarget(tool);
  if (!target || isFailedTool(tool) || (tool.status !== "completed" && tool.status !== "running")) return null;
  const args = isRecord(tool.args) ? tool.args : {};
  const identity = JSON.stringify(
    Object.fromEntries(Object.entries(args).filter(([key]) => !PAGING_ARGUMENTS.has(key))),
    (_key: string, value: unknown) =>
      typeof value === "string"
        ? value.trim()
        : isRecord(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
  );
  return { kind: "repeat", name: tool.name, target, identity };
};

const sameFold = (a: Fold, b: Fold): boolean =>
  a.kind === "housekeeping" ? b.kind === "housekeeping" : b.kind === "repeat" && a.name === b.name && a.identity === b.identity;

/**
 * The rows of the expanded work, in the original order. A run of at least two steps that fold together, with the
 * reasoning between them, becomes one row: housekeeping, or consecutive instances of the same call apart from paging,
 * such as reading one file in parts. Anything else between them, such as an intermediate text, ends the run. A run that
 * would hold all but one of the work's steps shows its steps directly, so the work line never opens to a summary of
 * itself. Entries listed in `shown` already show as rows of their own and never fold, so nothing a reader sees folds
 * away under them.
 * A folded row is keyed by its first tool, whose id is the same live and in history.
 */
export function groupWorkBlocks(blocks: readonly AiTurnBlock[], shown: ReadonlySet<string> = new Set()): AiWorkItem[] {
  const entries = blocks.filter((block): block is AiWorkEntry | Text => block.kind !== "steer_message");
  const steps = entries.filter((entry) => entry.kind !== "text" && isStep(entry)).length;
  const items: AiWorkItem[] = [];
  let fold: Fold | null = null;
  let run: AiWorkEntry[] = [];
  let trailing: AiWorkEntry[] = [];
  const flush = () => {
    if (fold && run.length > 0) {
      const runSteps = run.filter(isStep).length;
      const id = run[0]!.id;
      if (runSteps >= 2 && steps - runSteps >= 2)
        items.push(
          fold.kind === "housekeeping"
            ? { kind: "housekeeping", id, entries: run }
            : { kind: "repeat", id, target: fold.target, entries: run },
        );
      else for (const entry of run) items.push({ kind: "step", entry });
    }
    // Reasoning after the last folded step belongs to what comes next.
    for (const entry of trailing) items.push({ kind: "step", entry });
    fold = null;
    run = [];
    trailing = [];
  };
  for (const entry of entries) {
    const foldable = !shown.has(entry.id);
    const next = foldable && entry.kind === "tool" ? foldOf(entry) : null;
    if (next && entry.kind === "tool") {
      if (fold && !sameFold(fold, next)) flush();
      fold = next;
      run.push(...trailing, entry);
      trailing = [];
    } else if (foldable && entry.kind === "thinking" && run.length > 0) trailing.push(entry);
    else {
      flush();
      items.push(entry.kind === "text" ? { kind: "text", block: entry } : { kind: "step", entry });
    }
  }
  flush();
  return items;
}

/** "9 steps · 1 failed · 1 rejected" for a group of steps. */
export function countWorkSteps(entries: readonly AiWorkEntry[], locale: string): string {
  const t = aiChatMessages(locale);
  const tools = entries.filter((entry): entry is Tool => entry.kind === "tool");
  const steps = tools.length + entries.filter((entry) => entry.kind === "compaction").length;
  const failed = tools.filter(isFailedTool).length;
  const rejected = tools.filter((tool) => tool.status === "rejected").length;
  return [
    steps ? t.steps({ count: steps }) : "",
    failed ? t.groupFailed({ count: failed }) : "",
    rejected ? t.groupRejected({ count: rejected }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
