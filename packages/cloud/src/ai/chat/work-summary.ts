import type { AiTurnBlock } from "../protocol";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import { isFailedTool } from "./tool-groups";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/** An app a turn worked in, for the small tiles in its work line. */
export type AiWorkApp = { key: string; name: string; icon: string; accent?: string };

/** The work line shows at most this many app tiles; more apps still count in its sentence. */
export const AI_WORK_APP_TILES = 3;

const WEB_TOOLS = new Set(["web_search", "web_fetch", "web_extract", "fetch_file"]);
const FILE_READ_TOOLS = new Set(["read_file", "list_files", "view_image"]);
const FILE_WRITE_TOOLS = new Set(["write_file", "present", "markdown_to_pdf", "html_to_pdf"]);

/**
 * Cloud's own tools for building an automation (Code), by what they do; the sentence names the doing in this order, as in
 * v12: "Written, checked, tried out and submitted". Their tile is Code's, since they belong to no app.
 */
const CODE_WORK: Record<string, "write" | "check" | "try" | "submit"> = {
  code_init: "write",
  code_pull: "write",
  code_write: "write",
  code_check: "check",
  code_inspect: "check",
  code_run: "try",
  code_simulate: "try",
  code_test: "try",
  code_submit: "submit",
};
const CODE_ORDER = ["write", "check", "try", "submit"] as const;
const isCodeTool = (name: string) => name.startsWith("code_");

const tools = (blocks: AiTurnBlock[]): ToolBlock[] => blocks.filter((block): block is ToolBlock => block.kind === "tool");

/** The apps a turn worked in, in order of first use: an app's own tile, or the web's for web tools. */
export const workApps = (blocks: AiTurnBlock[]): AiWorkApp[] => {
  const apps = new Map<string, AiWorkApp>();
  // An app shows once a call there runs or went through; one waiting for a decision, refused, or failed is named in the
  // steps instead.
  for (const tool of tools(blocks).filter(
    (block) => (block.status === "running" || block.status === "completed") && !isFailedTool(block),
  )) {
    const presentation = tool.presentation;
    if (presentation?.kind === "capability") {
      const key = `app:${presentation.appId}`;
      if (!apps.has(key)) apps.set(key, { key, name: presentation.appName, icon: presentation.appIcon, accent: presentation.appAccent });
    } else if (WEB_TOOLS.has(tool.name) && !apps.has("web")) apps.set("web", { key: "web", name: "Web", icon: "ti ti-world" });
    else if (isCodeTool(tool.name) && !apps.has("code")) apps.set("code", { key: "code", name: "Code", icon: "ti ti-code" });
  }
  return [...apps.values()];
};

/** The error code of a failed call: `CODE: message` as persisted, or `code` in a structured error result. */
const failureCode = (tool: ToolBlock): string | null => {
  const result = tool.result;
  const code =
    typeof result === "string"
      ? /^([A-Z][A-Z0-9_]{2,})\b/.exec(result.trim())?.[1]
      : isRecord(result) && isRecord(result.error)
        ? result.error.code
        : isRecord(result)
          ? result.code
          : undefined;
  return typeof code === "string" ? code.toUpperCase() : null;
};

/** Why a failed call did not go through, as a kind the chat words itself; codes and messages never reach the person. */
export type AiStepFailure = "denied" | "not_found" | "timeout" | "other";

export const stepFailure = (tool: ToolBlock): AiStepFailure | null => {
  if (!isFailedTool(tool)) return null;
  const code = failureCode(tool) ?? "";
  if (/^(?:FORBIDDEN|UNAUTHORIZED|ACCESS_DENIED|PERMISSION_DENIED)$/.test(code)) return "denied";
  if (/^(?:NOT_FOUND|GONE)$/.test(code)) return "not_found";
  if (/TIMEOUT|DEADLINE/.test(code)) return "timeout";
  return "other";
};

/** A failed call that Cloud or the app refused for lack of access, as far as its result says so. */
export const isAccessDenied = (tool: ToolBlock): boolean => stepFailure(tool) === "denied";

/**
 * What a finished turn did, as one sentence in words: where it looked, where it changed something, and what it did with
 * the web and files. Only what went through counts; failures count in the step line. Empty when no step says more than
 * "worked".
 */
export const workSummary = (blocks: AiTurnBlock[], locale: string): string => {
  const t = aiChatMessages(locale);
  const list = (names: string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  const looked: string[] = [];
  const changed: string[] = [];
  let web = false;
  let readFiles = false;
  let wroteFiles = false;
  const code = new Set<(typeof CODE_ORDER)[number]>();
  for (const tool of tools(blocks)) {
    if (tool.status !== "completed" || isFailedTool(tool)) continue;
    const presentation = tool.presentation;
    if (presentation?.kind === "capability") {
      const names = presentation.capabilityKind === "action" ? changed : looked;
      if (!names.includes(presentation.appName)) names.push(presentation.appName);
    } else if (WEB_TOOLS.has(tool.name)) web = true;
    else if (FILE_READ_TOOLS.has(tool.name)) readFiles = true;
    else if (FILE_WRITE_TOOLS.has(tool.name)) wroteFiles = true;
    else if (CODE_WORK[tool.name]) code.add(CODE_WORK[tool.name]!);
  }
  const codeWork = CODE_ORDER.filter((work) => code.has(work)).map((work) => t.workCode[work]);
  const phrases = [
    looked.length > 0 ? t.workLookedIn({ apps: list(looked) }) : "",
    changed.length > 0 ? t.workChangedIn({ apps: list(changed) }) : "",
    web ? t.workSearchedWeb : "",
    readFiles ? t.workReadFiles : "",
    wroteFiles ? t.workCreatedFiles : "",
  ].filter(Boolean);
  // Building an automation reads as what was done with it; beside other work it names the code it was done to.
  if (codeWork.length > 0) phrases.push(phrases.length > 0 ? t.workCodeWith({ work: list(codeWork) }) : list(codeWork));
  const sentence = phrases.join(", ");
  return sentence ? sentence.charAt(0).toLocaleUpperCase(locale) + sentence.slice(1) : "";
};

/**
 * The step line after the sentence: how many steps, and what did not go through. Thinking counts as a step, like in the
 * opened list. `issues` stays visible where the count gives way to the sentence.
 */
export const workStepParts = (blocks: AiTurnBlock[], steps: number, locale: string): { count: string; issues: string[] } => {
  const t = aiChatMessages(locale);
  const thoughts = blocks.filter((block) => block.kind === "thinking" && block.text.trim()).length;
  const calls = tools(blocks);
  const denied = calls.filter(isAccessDenied).length;
  const failed = calls.filter(isFailedTool).length - denied;
  const rejected = calls.filter((tool) => tool.status === "rejected").length;
  return {
    count: t.steps({ count: steps + thoughts }),
    issues: [
      denied ? t.workNoAccess({ count: denied }) : "",
      failed ? t.workFailed({ count: failed }) : "",
      rejected ? t.workRejected({ count: rejected }) : "",
    ].filter(Boolean),
  };
};

export const workStepLine = (blocks: AiTurnBlock[], steps: number, locale: string): string => {
  const parts = workStepParts(blocks, steps, locale);
  return [parts.count, ...parts.issues].join(", ");
};
