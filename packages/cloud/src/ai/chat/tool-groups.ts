import type { AiTurnBlock } from "../protocol";
import { aiChatMessages } from "./messages";

type Tool = Extract<AiTurnBlock, { kind: "tool" }>;
type Text = Extract<AiTurnBlock, { kind: "text" }>;
export type AiWorkEntry = Exclude<AiTurnBlock, { kind: "text" } | { kind: "steer_message" }>;
export type AiWorkGroup = { kind: "text"; block: Text } | { kind: "steps"; id: string; entries: AiWorkEntry[] };

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

/**
 * Split folded work into intermediate texts and the step groups between them. Reasoning stays inside its group so it
 * does not break up the tools around it. A group is keyed by its first tool, whose id is the same live and in history.
 */
export function groupWorkBlocks(blocks: readonly AiTurnBlock[]): AiWorkGroup[] {
  const groups: AiWorkGroup[] = [];
  for (const block of blocks) {
    if (block.kind === "steer_message") continue;
    if (block.kind === "text") {
      groups.push({ kind: "text", block });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === "steps") last.entries.push(block);
    else groups.push({ kind: "steps", id: block.id, entries: [block] });
  }
  for (const group of groups) {
    if (group.kind === "steps") group.id = (group.entries.find((entry) => entry.kind === "tool") ?? group.entries[0]!).id;
  }
  return groups;
}

/** What a group of tools did, in categories; failures and rejections are counted separately. */
export function summarizeToolGroup(tools: readonly Tool[], locale: string): string {
  const t = aiChatMessages(locale);
  const categories = tools.map((tool) => {
    if (tool.name === "todo_write") return t.groupPlan;
    if (tool.name === "present" || tool.name === "code_present" || tool.name === "card" || tool.name === "cloud_card")
      return t.groupDelivered;
    if (tool.name.startsWith("code_")) return t.groupCode;
    if (tool.presentation?.kind === "capability" || tool.name === "read_cloud_resource") return t.groupCloud;
    if (["read_file", "list_files", "view_image"].includes(tool.name)) return t.groupReadFiles;
    if (tool.name === "write_file") return t.groupWriteFiles;
    if (["markdown_to_pdf", "html_to_pdf"].includes(tool.name)) return t.groupPdf;
    if (["load_skill", "load_tools", "search_tools", "list_apps"].includes(tool.name)) return t.groupLoad;
    if (tool.name.startsWith("web_") || tool.name === "fetch_file") return t.groupWeb;
    if (tool.name === "memory") return t.groupMemory;
    return t.groupTools;
  });
  return [...new Set(categories)].join(", ");
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
