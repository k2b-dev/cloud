import type { AiTurnBlock } from "../protocol";
import { isCardToolName, isSurveyToolName, isTextEditorToolName } from "./message-utils";

type Tool = Extract<AiTurnBlock, { kind: "tool" }>;
type Group = { kind: "tools"; blocks: Tool[] } | { kind: "block"; block: AiTurnBlock };

export function isFailedTool(tool: Tool): boolean {
  if (tool.isError || tool.status === "failed" || tool.status === "rejected") return true;
  const result = tool.result;
  return ["code_run","code_inspect","code_interact"].includes(tool.name) && result !== null && typeof result === "object" && "status" in result && result.status === "error";
}

/** Visible content and interactive decisions are boundaries; model request boundaries are not. */
export function groupToolBlocks(blocks: readonly AiTurnBlock[], hasUi: (tool: Tool) => boolean = () => false): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    const ordinary =
      block.kind === "tool" &&
      !block.approval &&
      block.status !== "awaiting_approval" &&
      !["present", "code_present", "view_image", "code_secret"].includes(block.name) &&
      !isCardToolName(block.name) &&
      !isSurveyToolName(block.name) &&
      !isTextEditorToolName(block.name) &&
      !hasUi(block);
    if (ordinary) {
      const last = groups.at(-1);
      if (last?.kind === "tools") last.blocks.push(block);
      else groups.push({ kind: "tools", blocks: [block] });
    } else groups.push({ kind: "block", block });
  }
  return groups;
}

export function summarizeToolGroup(tools: readonly Tool[], locale: string): string {
  const de = locale.startsWith("de");
  const categories = tools.map((tool) => {
    if (tool.name === "todo_write") return de ? "Arbeitsplan aktualisiert" : "Updated working plan";
    if (tool.name.startsWith("code_")) return de ? "Mit Code gearbeitet" : "Worked with code";
    if (tool.presentation?.kind === "capability" || tool.name === "read_cloud_resource")
      return de ? "Cloud-Integration verwendet" : "Used Cloud integration";
    if (["read_file", "list_files", "view_image"].includes(tool.name)) return de ? "Dateien gelesen" : "Read files";
    if (tool.name === "write_file") return de ? "Dateien geschrieben" : "Wrote files";
    if (["load_skill", "load_tools", "search_tools"].includes(tool.name))
      return de ? "Werkzeuge und Wissen geladen" : "Loaded tools and guidance";
    if (tool.name.startsWith("web_") || tool.name === "fetch_file") return de ? "Im Web recherchiert" : "Searched the web";
    return de ? "Werkzeuge verwendet" : "Used tools";
  });
  const errors = tools.filter(isFailedTool).length;
  return [...new Set(categories)].join(", ") + (errors ? ` · ${errors} ${de ? "fehlgeschlagen" : "failed"}` : "");
}
