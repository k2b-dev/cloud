import type {
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
  PermissionOption,
  PlanEntry,
  ToolCall,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { AiPendingTurnAction, AiTurnBlock, CloudAiSurveyInput, CloudAiTextEditorInput } from "@k2b/cloud/ai";
import {
  CLOUD_AI_TEXT_EDITOR_MAX_CHARS,
  CloudAiSurveyOutputSchema,
  CloudAiTextEditorOutputSchema,
  parseAiTodoPlan,
} from "@k2b/cloud/ai/browser";
import { capabilityReviewView } from "@k2b/cloud/capabilities";
import type { CloudCliTableColumn } from "@k2b/cloud/cli";
import { resolveLocalPath } from "./local-paths";
import { localToolTarget } from "./local-tool-target";
import type { LocalQuestionKind } from "./local-tools";
import { terminalSafeText } from "./terminal";

export type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
export type ApprovalAction = Extract<AiPendingTurnAction, { type: "approval_request" }>;
export const toolKind = (name: string): ToolKind => {
  if (["local_read", "read_file", "view_image", "load_skill", "load_local_skill"].includes(name)) return "read";
  if (["local_list", "web_search"].includes(name) || name.startsWith("search_")) return "search";
  if (["web_extract", "fetch_file"].includes(name)) return "fetch";
  if (["local_write", "local_download", "write_file"].includes(name)) return "edit";
  if (name === "local_move") return "move";
  if (["local_bash", "code_run"].includes(name)) return "execute";
  return name === "todo_write" ? "think" : "other";
};
export const boundedRaw = (value: unknown): unknown => {
  const json = JSON.stringify(value);
  return json !== undefined && json.length <= 16_000 ? value : undefined;
};
export const toolContent = (text: string): ToolCallContent[] => [
  { type: "content", content: { type: "text", text: terminalSafeText(text) } },
];
export const toolCall = (block: ToolBlock, cwd: string): ToolCall => {
  const args = block.args;
  const paths: string[] = [];
  if ((block.name.startsWith("local_") || block.name === "load_local_skill") && args && typeof args === "object") {
    if ("path" in args && typeof args.path === "string") paths.push(args.path);
    if ("to" in args && typeof args.to === "string") paths.push(args.to);
    if ("paths" in args && Array.isArray(args.paths)) for (const path of args.paths) if (typeof path === "string") paths.push(path);
    if ("moves" in args && Array.isArray(args.moves))
      for (const move of args.moves) {
        if (!move || typeof move !== "object") continue;
        if ("from" in move && typeof move.from === "string") paths.push(move.from);
        if ("to" in move && typeof move.to === "string") paths.push(move.to);
      }
  }
  const target = localToolTarget(block.name, args);
  const failed = block.status === "failed" || block.status === "rejected";
  const result = block.result;
  const error = result && typeof result === "object" && "error" in result ? result.error : result;
  return {
    toolCallId: block.id,
    title: terminalSafeText(block.presentation?.title ?? (target ? `${block.name} ${target}` : block.name)),
    kind: toolKind(block.name),
    status: block.status === "running" ? "in_progress" : block.status === "completed" ? "completed" : failed ? "failed" : "pending",
    locations: [...new Set(paths)].map((path) => ({ path: resolveLocalPath(path, cwd) })),
    ...(boundedRaw(args) !== undefined ? { rawInput: args } : {}),
    ...(boundedRaw(result) !== undefined ? { rawOutput: result } : {}),
    content: failed ? toolContent(typeof error === "string" ? error : (JSON.stringify(error) ?? block.status)) : [],
  };
};
export const planEntries = (args: unknown): PlanEntry[] | undefined =>
  parseAiTodoPlan(args)?.todos.flatMap((item) =>
    item.status === "cancelled" ? [] : [{ content: terminalSafeText(item.content), priority: "medium" as const, status: item.status }],
  );
export const isConfirmApproval = (action: ApprovalAction): boolean => !(action.allowChat || action.allowAlways || action.website);
export const approvalOptions = (action: ApprovalAction): PermissionOption[] =>
  isConfirmApproval(action)
    ? [
        { optionId: "cloud", name: "Confirm in Cloud", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ]
    : [
        { optionId: "once", name: "Approve once", kind: "allow_once" },
        ...(action.allowChat && !action.website
          ? [{ optionId: "chat", name: "Approve for this chat", kind: "allow_always" as const }]
          : []),
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ];
export const approvalReviewText = (action: ApprovalAction, link: string): string =>
  [
    (action.review
      ? capabilityReviewView(action.review, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).message
      : undefined) ??
      action.message ??
      action.name,
    ...(
      (action.review
        ? capabilityReviewView(action.review, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).details
        : undefined) ?? []
    ).map((detail) => `${terminalSafeText(detail.label)}: ${terminalSafeText(detail.value)}`),
    `Open in Cloud: ${link}`,
  ]
    .map(terminalSafeText)
    .join("\n");
export const localQuestion = (kind: LocalQuestionKind): { name: string; kind: ToolKind; reject: string } =>
  (
    ({
      bash: { name: "Run", kind: "execute", reject: "Reject" },
      append: { name: "Append", kind: "edit", reject: "Reject" },
      replace: { name: "Replace", kind: "other", reject: "Keep the current file" },
      move: { name: "Move", kind: "move", reject: "Reject" },
      instructions: { name: "Allow", kind: "other", reject: "Reject" },
      access: { name: "Allow", kind: "other", reject: "Reject" },
    }) satisfies Record<LocalQuestionKind, { name: string; kind: ToolKind; reject: string }>
  )[kind];
export const surveyForm = (input: CloudAiSurveyInput): ElicitationSchema => {
  const properties: Record<string, ElicitationPropertySchema> = {};
  for (const q of input.questions) {
    properties[q.id] =
      q.type === "text"
        ? { type: "string", title: q.label, description: q.placeholder }
        : q.type === "rating"
          ? { type: "integer", title: q.label, minimum: q.min, maximum: q.max }
          : q.type === "single"
            ? { type: "string", title: q.label, oneOf: q.options.map((o) => ({ const: o.value, title: o.label })) }
            : { type: "array", title: q.label, items: { anyOf: q.options.map((o) => ({ const: o.value, title: o.label })) } };
  }
  return { type: "object", properties, required: input.questions.filter((q) => q.required).map((q) => q.id) };
};
export const surveyResult = (input: CloudAiSurveyInput, response?: CreateElicitationResponse) => {
  const answers: Record<string, unknown> = {};
  const content = response?.action === "accept" ? response.content : undefined;
  if (content && typeof content === "object")
    for (const q of input.questions) {
      const value: unknown = Object.entries(content).find(([key]) => key === q.id)?.[1];
      const valid =
        q.type === "text"
          ? typeof value === "string"
          : q.type === "rating"
            ? typeof value === "number" && Number.isInteger(value) && value >= q.min && value <= q.max
            : q.type === "single"
              ? q.options.some((o) => o.value === value)
              : Array.isArray(value) && value.every((v) => typeof v === "string" && q.options.some((o) => o.value === v));
      if (valid) answers[q.id] = value;
    }
  return CloudAiSurveyOutputSchema.parse({ submitted: response?.action === "accept", answers });
};
export const textEditorForm = (input: CloudAiTextEditorInput): ElicitationSchema => ({
  type: "object",
  properties: { content: { type: "string", title: "Text", default: input.content, maxLength: CLOUD_AI_TEXT_EDITOR_MAX_CHARS } },
  required: ["content"],
});
export const textEditorResult = (input: CloudAiTextEditorInput, response?: CreateElicitationResponse) => {
  const content = response?.action === "accept" ? response.content : undefined;
  if (
    content &&
    typeof content === "object" &&
    "content" in content &&
    typeof content.content === "string" &&
    content.content.length > CLOUD_AI_TEXT_EDITOR_MAX_CHARS
  )
    return {
      submitted: false,
      feedback: `The edited draft is longer than ${CLOUD_AI_TEXT_EDITOR_MAX_CHARS.toLocaleString("en-US")} characters, so it was not sent. Ask in the chat what to shorten.`,
    };
  return CloudAiTextEditorOutputSchema.parse(
    content && typeof content === "object" && "content" in content && typeof content.content === "string"
      ? { submitted: true, content: content.content, format: input.format }
      : {
          submitted: false,
          feedback: response
            ? "The user rejected the draft. Ask in the chat what to change."
            : "This client cannot show drafts. Put the draft in your reply and ask the user there.",
        },
  );
};
export const markdownTable = <T extends Record<string, unknown>>(rows: T[], columns: CloudCliTableColumn<T>[]): string => {
  const cell = (value: unknown) =>
    terminalSafeText((value == null ? "" : String(value)).replaceAll(/\r\n?/g, "\n"))
      .replaceAll("|", "\\|")
      .replaceAll(/\r?\n/g, "<br>");
  const row = (cells: unknown[]) => `| ${cells.map(cell).join(" | ")} |`;
  return (
    [
      row(columns.map((c) => c.label ?? String(c.key))),
      row(columns.map(() => "---")),
      ...rows.map((r) => row(columns.map((c) => (c.value ? c.value(r) : r[String(c.key)])))),
    ].join("\n") + "\n"
  );
};
