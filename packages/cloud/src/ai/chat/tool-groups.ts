import { aiSkillFilePathFromMount } from "../file-mount";
import type { AiTurnBlock } from "../protocol";
import { aiChatMessages } from "./messages";

type Tool = Extract<AiTurnBlock, { kind: "tool" }>;
type Text = Extract<AiTurnBlock, { kind: "text" }>;
export type AiWorkEntry = Exclude<AiTurnBlock, { kind: "text" } | { kind: "steer_message" }>;
/**
 * One row of the expanded work, all at one indent: an intermediate text, a step, or a group that folds housekeeping
 * steps and opens in place.
 */
export type AiWorkItem =
  | { kind: "text"; block: Text }
  | { kind: "step"; entry: AiWorkEntry }
  | { kind: "housekeeping"; id: string; entries: AiWorkEntry[] };

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

/**
 * The rows of the expanded work, in the original order. A run of at least two housekeeping steps, with the reasoning
 * between them, folds into one group, unless it would hold all but one of the work's steps: then the steps show
 * directly, so the work line never opens to a summary of itself. Entries listed in `shown` already show as rows of
 * their own and never fold into a group, so nothing a reader sees folds away under them. A group is keyed by its first
 * tool, whose id is the same live and in history.
 */
export function groupWorkBlocks(blocks: readonly AiTurnBlock[], shown: ReadonlySet<string> = new Set()): AiWorkItem[] {
  const entries = blocks.filter((block): block is AiWorkEntry | Text => block.kind !== "steer_message");
  const steps = entries.filter((entry) => entry.kind !== "text" && isStep(entry)).length;
  const items: AiWorkItem[] = [];
  let run: AiWorkEntry[] = [];
  let trailing: AiWorkEntry[] = [];
  const flush = () => {
    if (run.length > 0) {
      const runSteps = run.filter(isStep).length;
      if (runSteps >= 2 && steps - runSteps >= 2) items.push({ kind: "housekeeping", id: run[0]!.id, entries: run });
      else for (const entry of run) items.push({ kind: "step", entry });
    }
    // Reasoning after the last housekeeping step belongs to what comes next.
    for (const entry of trailing) items.push({ kind: "step", entry });
    run = [];
    trailing = [];
  };
  for (const entry of entries) {
    const foldable = !shown.has(entry.id);
    if (foldable && entry.kind === "tool" && isHousekeepingTool(entry)) {
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
