import type { AiTurnBlock } from "../protocol";
import { codeStepWords } from "./code-step-words";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import { isFailedTool } from "./tool-groups";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

const WEB_TOOLS = new Set(["web_search", "web_fetch", "web_extract", "fetch_file"]);
const FILE_READ_TOOLS = new Set(["read_file", "list_files", "view_image"]);
const FILE_WRITE_TOOLS = new Set(["write_file", "markdown_to_pdf", "html_to_pdf", "code_export"]);

const tools = (blocks: AiTurnBlock[]): ToolBlock[] => blocks.filter((block): block is ToolBlock => block.kind === "tool");

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

type AutomationWork = {
  prepared: boolean;
  changed: boolean;
  checked: boolean;
  permissions: boolean;
  submitted: boolean;
  examples: { passed: number; total: number } | null;
  testedInput: Record<string, unknown> | null;
};

const emptyAutomationWork = (): AutomationWork => ({
  prepared: false,
  changed: false,
  checked: false,
  permissions: false,
  submitted: false,
  examples: null,
  testedInput: null,
});

const sameDraftPart = (a: unknown, b: unknown): boolean => {
  if (typeof a === "string") return a === b;
  if (!isRecord(a) || !isRecord(b)) return false;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => typeof value === "string" && value === b[key])
  );
};

/** Current stored test results carry cases; the readable result adds words without removing those cases. */
const testedExamples = (tool: ToolBlock): AutomationWork["examples"] => {
  const words = codeStepWords(tool)?.examples;
  const result = isRecord(tool.result) ? tool.result : {};
  const cases = Array.isArray(result.cases) ? result.cases : [];
  const examples =
    words ??
    (result.words === undefined && cases.length > 0 && cases.every((item) => isRecord(item) && typeof item.ok === "boolean")
      ? { passed: cases.filter((item) => isRecord(item) && item.ok === true).length, total: cases.length }
      : null);
  return examples &&
    Number.isSafeInteger(examples.passed) &&
    Number.isSafeInteger(examples.total) &&
    examples.total > 0 &&
    examples.passed >= 0 &&
    examples.passed <= examples.total
    ? { passed: examples.passed, total: examples.total }
    : null;
};

/** Keep evidence with its automation and draft. A pull resets the draft; a write invalidates earlier checks. */
/** The automation's outcomes; `result` when they are its effect and its counted examples, one finding (F5). */
const automationPhrases = (calls: ToolBlock[], t: ReturnType<typeof aiChatMessages>): { parts: string[]; result: boolean } => {
  const drafts = new Map<string, AutomationWork>();
  let current: AutomationWork | undefined;
  for (const tool of calls) {
    if (!["code_init", "code_pull", "code_read", "code_write", "code_check", "code_test", "code_simulate", "code_submit"].includes(tool.name))
      continue;
    const args = isRecord(tool.args) ? tool.args : {};
    const result = isRecord(tool.result) ? tool.result : {};
    const config = isRecord(result.config) ? result.config : {};
    const draft = isRecord(result.draft) ? result.draft : {};
    const codeId = [args.codeId, config.codeId, draft.codeId].find((id): id is string => typeof id === "string");
    // Without an identity, don't join separate calls into a claim about the same draft.
    const known = codeId === undefined ? undefined : drafts.get(codeId);
    const state = known ?? emptyAutomationWork();
    const failed = isFailedTool(tool);
    // A test with failed examples is evidence too. A transport/tool error with no usable result is not, and leaves the
    // earlier count of the unchanged draft standing.
    const testResult = tool.name === "code_test" && !tool.isError && !result.error;
    if (tool.status !== "completed" || (failed && !testResult)) continue;
    // A simulation only says something here when it replaced a part of a draft this turn already worked on.
    if (tool.name === "code_simulate" && !known) continue;
    if (codeId !== undefined) drafts.set(codeId, state);
    if (tool.name !== "code_simulate") current = state;
    if (["code_init", "code_pull", "code_read"].includes(tool.name)) {
      Object.assign(state, emptyAutomationWork());
      state.prepared = tool.name === "code_init" || (config.baseVersionId === null && tool.name !== "code_read");
      // Reading an automation never counts as changing it, even when nothing of it is saved yet.
      state.changed = tool.name === "code_init";
    }
    const replaced = ["files", "tests", "entry"].some(
      (part) => args[part] !== undefined && !sameDraftPart(args[part], state.testedInput?.[part]),
    );
    if (tool.name === "code_write" || replaced) {
      if (state.submitted) state.prepared = false;
      // A draft without a saved version underneath is a new automation; one with a base changes an existing one.
      // `null` is evidence here (no saved version), so it must not fall through to the next source.
      const base = "baseVersionId" in draft ? draft.baseVersionId : config.baseVersionId;
      if (base !== undefined) state.prepared = base === null;
      state.changed = true;
      state.checked = false;
      state.permissions = false;
      state.examples = null;
      state.testedInput = null;
      state.submitted = false;
    }
    const words = codeStepWords(tool);
    if (tool.name === "code_check") {
      state.checked = true;
      state.permissions = words?.mayDo !== undefined;
    }
    if (tool.name === "code_test") {
      state.checked = true;
      state.examples = testedExamples(tool);
      state.testedInput = state.examples ? args : null;
    }
    if (tool.name === "code_submit") state.submitted = true;
  }
  if (!current) return { parts: [], result: false };
  const examples = current.examples ? t.workAutomationExamples(current.examples) : current.changed ? t.workAutomationNoExamples : "";
  if (current.submitted) return { parts: [examples, t.workAutomationSubmitted].filter(Boolean), result: false };
  if (current.changed)
    return { parts: [current.prepared ? t.workAutomationPrepared : t.workAutomationChanged, examples], result: current.examples !== null };
  return {
    parts: [
      examples || (current.permissions ? t.workAutomationPermissions : current.checked ? t.workAutomationChecked : t.workAutomationRead),
    ],
    result: false,
  };
};

/**
 * At most two confirmed outcomes. Examples come from the last test of the latest draft, including failed examples.
 * Missing evidence uses general words; failure counts and duration stay outside the sentence.
 */
export const workSummary = (blocks: AiTurnBlock[], locale: string): string => {
  const t = aiChatMessages(locale);
  const list = (names: string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  const looked: string[] = [];
  const changed: string[] = [];
  let web = false;
  let readFiles = false;
  let readFile = false;
  let calculated = false;
  let analyzedFile = false;
  let uncountedFiles = false;
  const files = new Map<string, string>();
  const calls = tools(blocks);
  for (const tool of calls) {
    if (tool.status !== "completed" || isFailedTool(tool)) continue;
    const presentation = tool.presentation;
    // Cloud's own capabilities belong to no app the person knows by name; the sentence names only catalog apps.
    if (presentation?.kind === "capability" && presentation.appId === "core") continue;
    if (presentation?.kind === "capability") {
      const names = presentation.capabilityKind === "action" ? changed : looked;
      if (!names.includes(presentation.appName)) names.push(presentation.appName);
    } else if (WEB_TOOLS.has(tool.name)) web = true;
    else if (FILE_READ_TOOLS.has(tool.name)) {
      readFiles = true;
      if (tool.name === "read_file") readFile = true;
    } else if (tool.name === "code_run") {
      // Only a run that ended is a calculation; one still running, stopped or lost is not.
      if (isRecord(tool.result) && ["running", "cancelled", "error", "lost"].includes(String(tool.result.status))) continue;
      calculated = true;
      analyzedFile ||= readFile;
    } else if (FILE_WRITE_TOOLS.has(tool.name)) {
      const result = isRecord(tool.result) ? tool.result : {};
      if (typeof result.path === "string") files.set(result.path, typeof result.mediaType === "string" ? result.mediaType : "");
      else uncountedFiles = true;
    }
  }
  const automation = automationPhrases(calls, t);
  const phrases = [
    ...automation.parts,
    calculated ? (analyzedFile ? t.workAnalyzedFile : t.workCalculated) : "",
    uncountedFiles
      ? t.workCreatedFiles
      : files.size === 1 && [...files.values()][0] === "text/csv"
        ? t.workStoredTable
        : files.size > 0
          ? t.workStoredFiles({ count: files.size })
          : "",
    changed.length > 0 ? t.workChangedIn({ apps: list(changed) }) : "",
    looked.length > 0 ? t.workLookedIn({ apps: list(looked) }) : "",
    web ? t.workSearchedWeb : "",
    readFiles && !calculated ? t.workReadFiles : "",
  ].filter(Boolean);
  // The catalog words its parts as they read inside a sentence; only the sentence's first letter becomes capital. An
  // effect and its tested result read "Automation vorbereitet · 3 von 3 Beispielen erfolgreich" (Feinschliff F5).
  const [first = "", second] = phrases;
  const sentence = second === undefined ? first : `${first}${automation.result ? " · " : ", "}${second}`;
  return sentence ? sentence.charAt(0).toLocaleUpperCase(locale) + sentence.slice(1) : "";
};

/**
 * The step line after the sentence: how many steps, and what did not go through. Thinking counts as a step, like in the
 * opened list. `issues` stays visible where the count gives way to the sentence.
 */
/** What did not go through, with the tone its meta word takes (Feinschliff 2): failed in red, no access as a warning. */
export type AiWorkIssue = { text: string; tone: "danger" | "warning" | "neutral" };

export const workStepParts = (blocks: AiTurnBlock[], steps: number, locale: string): { count: string; issues: AiWorkIssue[] } => {
  const t = aiChatMessages(locale);
  const thoughts = blocks.filter((block) => block.kind === "thinking" && block.text.trim()).length;
  const calls = tools(blocks);
  const denied = calls.filter(isAccessDenied).length;
  const failed = calls.filter(isFailedTool).length - denied;
  const rejected = calls.filter((tool) => tool.status === "rejected").length;
  return {
    count: t.steps({ count: steps + thoughts }),
    issues: [
      denied ? { text: t.workNoAccess({ count: denied }), tone: "warning" as const } : null,
      failed ? { text: t.workFailed({ count: failed }), tone: "danger" as const } : null,
      rejected ? { text: t.workRejected({ count: rejected }), tone: "neutral" as const } : null,
    ].filter((issue) => issue !== null),
  };
};

export const workStepLine = (blocks: AiTurnBlock[], steps: number, locale: string): string => {
  const parts = workStepParts(blocks, steps, locale);
  return [parts.count, ...parts.issues.map((issue) => issue.text)].join(", ");
};
