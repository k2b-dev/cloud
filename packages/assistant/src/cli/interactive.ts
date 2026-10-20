import { realpathSync, statSync } from "node:fs";
import { release as osRelease, type as osType } from "node:os";
import { basename, relative, sep } from "node:path";
import type {
  AiConversation,
  AiDraftContentPart,
  AiFileStat,
  AiPendingTurnAction,
  AiProject,
  AiPublicModelProfile,
  AiSkillSummary,
  AiStoredMessage,
  CloudAiSurveyInput,
  CloudAiTextEditorInput,
} from "@k2b/cloud/ai";
import {
  AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS,
  AI_LOCAL_TOOL_NAMES,
  AI_TURN_ATTACHMENT_MAX_ITEMS,
  CloudAiSurveyInputSchema,
  CloudAiTextEditorInputSchema,
} from "@k2b/cloud/ai/browser";
import { capabilityReviewView } from "@k2b/cloud/capabilities";
import { arg, type CloudCliContext, command, flag } from "@k2b/cloud/cli";
import type { AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { httpApprovalNotice } from "../artifacts/code-approval-message";
import type { CapabilityDecision, CodeApproval } from "../artifacts/runtime/capabilities";
import { pendingActionQuestion } from "./action-question";
import { readApprovalPreferences, revokeApprovalPreference } from "./approvals";
import { closeCliCodeHost } from "./code-host";
import { createLineReader, type LineReader } from "./line-reader";
import { createLocalContextReader, type LocalContext, type LocalSkill, localSkillCatalog, readLocalSkill } from "./local-context";
import { classifyLocalPath, completeLocalPath, extractMessageAttachments, lastMentionToken, resolveLocalPath } from "./local-paths";
import { createLocalSessionFolder, runLocalTool } from "./local-tools";
import { jsonRequest, readApi, readProjectsApi } from "./shared";
import {
  type AssistantClientTools,
  type AssistantTurnOutput,
  type AssistantTurnStreamResult,
  createAssistantTurnOutput,
  streamAssistantTurn,
} from "./stream";
import { selectNumberedChoice, terminalInfo, terminalSafeText } from "./terminal";
import { editTextWithExternalEditor } from "./text-editor";
import {
  conversationPath,
  readConversationDetail,
  resolveConversation,
  submitAssistantTurn,
  uploadAttachment,
  validateLocalAttachments,
} from "./turn";

type InteractiveOptions = {
  conversationId?: string;
  title?: string;
  model?: string;
  projectId?: string;
  attachments?: string[];
  initialPrompt?: string;
  allowBash?: boolean;
  noBash?: boolean;
};

type FileList = { files: AiFileStat[]; totalBytes: number };
type AssistantStatus = { defaultModelId?: string; models?: AiPublicModelProfile[] };

export const INTERACTIVE_COMMANDS: ReadonlyArray<{ name: string; usage: string; summary: string }> = [
  { name: "/help", usage: "/help", summary: "Show these commands" },
  { name: "/new", usage: "/new", summary: "Start a new chat on the next message" },
  { name: "/resume", usage: "/resume [chat-id]", summary: "Open a recent chat" },
  { name: "/project", usage: "/project [id|none]", summary: "Choose a Project for this chat" },
  { name: "/model", usage: "/model [id|default]", summary: "Choose interactively or set the session model" },
  { name: "/retry", usage: "/retry [retry|details|concise]", summary: "Answer the last user message again" },
  { name: "/attach", usage: "/attach <path>", summary: "Attach a local file to the next message" },
  { name: "/skills", usage: "/skills", summary: "List local and Cloud Skills" },
  { name: "/files", usage: "/files", summary: "List files in this chat" },
  { name: "/web", usage: "/web", summary: "Open this chat in your browser" },
  { name: "/status", usage: "/status", summary: "Show this session's settings" },
  { name: "/usage", usage: "/usage", summary: "Show usage shares and reset dates" },
  { name: "/permissions", usage: "/permissions [ask|off]", summary: "Change local tools mode" },
  { name: "/approvals", usage: "/approvals [approval-id]", summary: "List and revoke remembered Cloud approvals" },
  { name: "/exit", usage: "/exit", summary: "End the session" },
];

type LocalToolsMode = "ask" | "off";

/** Complete session commands or the local path at the cursor. */
export const completeInteractiveLine = (line: string, cwd: string, skillNames: readonly string[] = []): [string[], string] => {
  if (line.startsWith("/") && !/\s/.test(line)) {
    return [
      [...new Set([...INTERACTIVE_COMMANDS.map((command) => command.name), ...skillNames.map((name) => `/${name}`)])].filter((name) =>
        name.startsWith(line),
      ),
      line,
    ];
  }
  const token = line.startsWith("/attach ") ? line.slice(8) : lastMentionToken(line);
  return [line.startsWith("/attach ") || token.startsWith("@") ? completeLocalPath(token, cwd) : [], token];
};

const printInteractiveHelp = (ctx: CloudCliContext): void => {
  const width = Math.max(...INTERACTIVE_COMMANDS.map((command) => command.usage.length)) + 3;
  for (const command of INTERACTIVE_COMMANDS) ctx.print(`${command.usage.padEnd(width)}${command.summary}`);
  ctx.print(`${"/<skill>".padEnd(width)}Select a Skill for your next message (/skills lists them)`);
};

const readInitialModelLabel = async (ctx: CloudCliContext, requestedModelId?: string): Promise<string> => {
  try {
    const status = await readApi<AssistantStatus>(ctx, "/status");
    const modelId = requestedModelId ?? status.defaultModelId;
    return status.models?.find((profile) => profile.id === modelId)?.label ?? modelId ?? "Cloud default";
  } catch {
    return requestedModelId ?? "Cloud default";
  }
};

const printInfo = (ctx: CloudCliContext, message: string): void => {
  ctx.print(terminalInfo(message));
};

const printResumeHint = (ctx: CloudCliContext, conversationId: string, created = false): void => {
  ctx.print();
  printInfo(ctx, created ? "New chat created. Resume this chat later with:" : "Resume this chat later with:");
  ctx.print(`      cld assistant --chat ${terminalSafeText(conversationId)}`);
  ctx.print();
};

const readChoice = async (
  reader: Pick<LineReader, "read">,
  prompt: string,
  allowed: readonly string[],
  defaultValue?: string,
): Promise<string | null> => {
  while (true) {
    const answer = (await reader.read(prompt, { typedOnly: true }))?.trim().toLowerCase();
    if (answer === undefined) return null;
    if (!answer && defaultValue) return defaultValue;
    if (allowed.includes(answer)) return answer;
  }
};

type ApprovalAnswer = "once" | "chat" | "always" | "deny";

const APPROVAL_INPUT_PREVIEW_CHARS = 16_000;

/** The reviewed input of an approval, escaped and bounded so oversized model-supplied input cannot flood the terminal. */
const approvalInputPreview = (input: unknown): string => {
  const json = JSON.stringify(input, null, 2);
  if (json.length <= APPROVAL_INPUT_PREVIEW_CHARS) return terminalSafeText(json);
  return `${terminalSafeText(json.slice(0, APPROVAL_INPUT_PREVIEW_CHARS))}\n[Input preview is incomplete; deny if you need to see the rest.]`;
};

/** A deliberate typed yes approves once; Enter denies and invalid answers ask again. */
const readApproval = async (reader: Pick<LineReader, "read">, question: string): Promise<ApprovalAnswer | null> => {
  const answer = await readChoice(reader, `${question} [y/N]: `, ["y", "yes", "n", "no"], "n");
  if (answer === null) return null;
  return answer === "y" || answer === "yes" ? "once" : "deny";
};

/** Offer only the approval scopes the server permits for this action. */
export const collectActionApproval = async (
  ctx: CloudCliContext,
  reader: Pick<LineReader, "read">,
  action: { allowAlways: boolean; allowChat?: boolean; website?: string },
): Promise<{ approved: boolean; remember?: "chat" | "always" } | null> => {
  const choices: Array<{ value: ApprovalAnswer; label: string }> = [{ value: "once", label: "Approve once" }];
  if (action.allowChat && !action.website) choices.push({ value: "chat", label: "Approve for this chat" });
  if (action.allowAlways && !action.website) choices.push({ value: "always", label: "Always approve" });
  let closed = false;
  const answer =
    choices.length === 1
      ? await readApproval(reader, "Approve?")
      : await selectNumberedChoice({
          output: ctx,
          reader: {
            read: async (prompt) => {
              const answer = await reader.read(prompt, { typedOnly: true });
              closed = answer === null;
              return answer;
            },
          },
          title: "Approve?",
          prompt: "Choice [Enter to reject]: ",
          choices,
        });
  if (closed || answer === null) return null;
  return {
    approved: answer === "once" || answer === "chat" || answer === "always",
    ...(answer === "chat" || answer === "always" ? { remember: answer } : {}),
  };
};

export const collectSurveyResult = async (
  ctx: CloudCliContext,
  reader: Omit<LineReader, "readMessage">,
  args: unknown,
): Promise<unknown | null> => {
  const parsed = CloudAiSurveyInputSchema.safeParse(args);
  if (!parsed.success) return null;
  const survey: CloudAiSurveyInput = parsed.data;
  ctx.print(terminalSafeText(survey.title));
  if (survey.description) ctx.print(terminalSafeText(survey.description));
  const answers: Record<string, unknown> = {};

  for (const question of survey.questions) {
    if (question.type === "text") {
      while (true) {
        const answer = await reader.read(`${terminalSafeText(question.label)}${question.required ? " *" : ""}: `);
        if (answer === null) return null;
        if (answer.trim() || !question.required) {
          if (answer.trim()) answers[question.id] = answer.trim();
          break;
        }
      }
      continue;
    }

    if (question.type === "rating") {
      while (true) {
        const answer = await reader.read(
          `${terminalSafeText(question.label)} (${question.min}-${question.max})${question.required ? " *" : ""}: `,
        );
        if (answer === null) return null;
        if (!answer.trim() && !question.required) break;
        const rating = Number(answer);
        if (Number.isInteger(rating) && rating >= question.min && rating <= question.max) {
          answers[question.id] = rating;
          break;
        }
      }
      continue;
    }

    ctx.print(terminalSafeText(question.label));
    question.options.forEach((option, index) => ctx.print(`  ${index + 1}. ${terminalSafeText(option.label)}`));
    while (true) {
      const answer = await reader.read(`${question.type === "multiple" ? "Choices" : "Choice"}${question.required ? " *" : ""}: `);
      if (answer === null) return null;
      if (!answer.trim() && !question.required) break;
      const indexes = answer
        .split(",")
        .map((value) => Number(value.trim()) - 1)
        .filter((value) => Number.isInteger(value) && value >= 0 && value < question.options.length);
      const unique = [...new Set(indexes)];
      if (unique.length === 0 || (question.type === "single" && unique.length !== 1)) continue;
      const values = unique.map((index) => question.options[index]!.value);
      answers[question.id] = question.type === "single" ? values[0] : values;
      break;
    }
  }
  return { submitted: true, answers };
};

export const collectTextEditorResult = async (
  ctx: CloudCliContext,
  reader: Omit<LineReader, "readMessage">,
  args: unknown,
  edit: (input: CloudAiTextEditorInput) => Promise<unknown> = editTextWithExternalEditor,
): Promise<unknown | null> => {
  const parsed = CloudAiTextEditorInputSchema.safeParse(args);
  if (!parsed.success) return null;
  let input = parsed.data;
  ctx.print(terminalSafeText(input.title));
  if (input.description) ctx.print(terminalSafeText(input.description));
  ctx.print();
  ctx.print(terminalSafeText(input.content));
  ctx.print();

  while (true) {
    const answer = await readChoice(reader, "Use this text? [Y/e=edit/c=cancel]: ", ["y", "yes", "e", "edit", "c", "cancel"], "y");
    if (answer === null || answer === "c" || answer === "cancel") return null;
    if (answer === "y" || answer === "yes") {
      return { submitted: true, content: input.content, format: input.format };
    }
    try {
      reader.pause?.();
      const edited = CloudAiTextEditorInputSchema.pick({ content: true, format: true }).safeParse(await edit(input));
      if (!edited.success) throw new Error("The editor returned invalid text.");
      input = { ...input, content: edited.data.content, format: edited.data.format };
    } catch (error) {
      ctx.error(error instanceof Error ? error.message : "Could not edit the text.");
      return null;
    } finally {
      reader.resume?.();
    }
  }
};

const submitAction = async (ctx: CloudCliContext, action: AiPendingTurnAction, body: unknown): Promise<void> => {
  await readApi(
    ctx,
    conversationPath(action.conversationId, `/turns/${encodeURIComponent(action.turnId)}/actions/${encodeURIComponent(action.callId)}`),
    jsonRequest("POST", body),
  );
};

const resolveAttention = async (input: {
  ctx: CloudCliContext;
  reader: LineReader;
  conversationId: string;
  turnId: string;
  signal: AbortSignal;
  clientTools: AssistantClientTools;
  output: AssistantTurnOutput;
}): Promise<AssistantTurnStreamResult | null> => {
  let result = { status: "needs_attention" as const, turnId: input.turnId };
  while (result.status === "needs_attention") {
    if (input.signal.aborted) return null;
    const actions = await readApi<AiPendingTurnAction[]>(
      input.ctx,
      conversationPath(input.conversationId, `/pending-actions/${encodeURIComponent(input.turnId)}`),
    );
    if (input.signal.aborted) return null;
    const action = actions[0];
    if (!action) return null;

    if (action.type === "approval_request") {
      const question = pendingActionQuestion(input.ctx, action);
      for (const line of question.lines) input.ctx.print(line);
      if (!question.hasRows) input.ctx.print(approvalInputPreview(action.args));
      const decision = await collectActionApproval(input.ctx, input.reader, action);
      if (decision === null) return null;
      await submitAction(input.ctx, action, { type: "approval_response", ...decision });
    } else if (action.name === "survey" || action.name === "cloud_survey") {
      const surveyResult = await collectSurveyResult(input.ctx, input.reader, action.args);
      if (surveyResult === null) {
        input.ctx.error("The survey could not be completed in this terminal session.");
        return null;
      }
      await submitAction(input.ctx, action, { type: "tool_result", result: surveyResult });
    } else if (action.name === "text_editor" || action.name === "cloud_text_editor") {
      const editorResult = await collectTextEditorResult(input.ctx, input.reader, action.args);
      if (editorResult === null) {
        input.ctx.error("The text editor was left pending.");
        return null;
      }
      await submitAction(input.ctx, action, { type: "tool_result", result: editorResult });
    } else {
      input.ctx.error(terminalSafeText(`Frontend tool ${action.name} needs a result.`));
      input.ctx.error(
        `Run \`cld assistant actions submit ${input.conversationId} ${input.turnId} ${action.callId} --result-file <file>\`.`,
      );
      return null;
    }

    const streamed = await streamAssistantTurn({
      ctx: input.ctx,
      conversationId: input.conversationId,
      turnId: input.turnId,
      output: input.output,
      clientTools: input.clientTools,
      signal: input.signal,
      onCapabilityApproval: (request) => collectCapabilityApproval(input.ctx, input.reader, request),
    });
    if (streamed.status !== "needs_attention") return streamed.status === "idle" ? null : streamed;
    result = { status: "needs_attention", turnId: input.turnId };
  }
  return null;
};

export async function collectCapabilityApproval(
  ctx: CloudCliContext,
  reader: Omit<LineReader, "readMessage">,
  request: CodeApproval,
): Promise<CapabilityDecision> {
  if ("type" in request) {
    ctx.print(terminalSafeText(`External HTTP: ${request.method} ${request.url}`));
    ctx.print(terminalSafeText(httpApprovalNotice(request, "en")));
    ctx.print(terminalSafeText(JSON.stringify(request.headers, null, 2)));
    if (request.bodyBytes) ctx.print(terminalSafeText(`${request.bodyBytes} bytes: ${request.bodyPreview}`));
    if (request.bodyTruncated) ctx.print("Body preview is incomplete; review source and inputs before approving.");
    return { approved: (await readApproval(reader, "Send request?")) === "once" };
  }

  if (request.resource) {
    ctx.print(terminalSafeText(`App: ${request.resource.title}`));
    ctx.print("Returned Cloud data may be stored in this app and read by others with access. Personal remembered approvals do not apply.");
  }
  ctx.print(
    terminalSafeText(
      (request.review
        ? capabilityReviewView(request.review, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).message
        : undefined) ?? request.title,
    ),
  );
  ctx.print(approvalInputPreview(request.input));
  const decision = await collectActionApproval(ctx, reader, request);
  return decision?.remember === "always" ? { approved: true, remember: "always" } : { approved: decision?.approved === true };
}

/** The local client fields of a turn, the same for the terminal and an editor. */
export const localTurnFields = (input: {
  context: LocalContext;
  localTools: "ask" | "off";
  workspace: string;
  client: { kind: "cli" | "acp"; name?: string };
}) => {
  const skills = input.localTools === "ask" ? localSkillCatalog(input.context) : [];
  return {
    clientToolIds:
      input.localTools === "ask"
        ? ["local_bash", ...AI_LOCAL_TOOL_NAMES.filter((name) => name !== "load_local_skill" || skills.length > 0)]
        : [],
    client: { ...input.client, cwd: input.workspace, os: `${osType()} ${osRelease()}`, shell: "/bin/bash", localTools: input.localTools },
    localContext: { instructions: input.context.instructions, skills },
  };
};

export const readSelectedLocalSkill = async (input: {
  skill: LocalSkill;
  context: LocalContext;
  workspace: string;
  ask: (question: string) => Promise<boolean>;
}) => {
  const { skill, context, workspace, ask } = input;
  const rule = classifyLocalPath(skill.path, { workspace });
  if (rule.access === "blocked") throw new Error("cld's configuration is never available to the assistant.");
  const target = realpathSync(skill.path);
  const free = context.skills.some(({ directory }) => {
    const child = relative(directory, target);
    return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep));
  });
  if (rule.access === "ask" && !free) {
    const question =
      rule.reason === "home"
        ? `Read ${skill.path}? You started cld in your home folder or above, so every file asks first.`
        : rule.reason === "protected"
          ? `Read ${skill.path}? It may contain secrets.`
          : `Read ${skill.path}? It is outside ${workspace}.`;
    if (!(await ask(terminalSafeText(question)))) return null;
  }
  return readLocalSkill(skill, workspace);
};

export const runInteractiveAssistant = async (
  ctx: CloudCliContext,
  options: InteractiveOptions,
  suppliedReader?: LineReader,
): Promise<number> => {
  if (options.allowBash && options.noBash) throw new Error("Pass either --allow-bash or --no-bash.");
  const workspace = process.cwd();
  let context: LocalContext;
  let cloudSkills: AiSkillSummary[] = [];
  const skillNames = () => [...(context?.skills.map((skill) => skill.name) ?? []), ...cloudSkills.map((skill) => skill.name)];
  const reader =
    suppliedReader ?? createLineReader({ cwd: workspace, completer: (line) => completeInteractiveLine(line, workspace, skillNames()) });
  const choiceReader = { read: (prompt: string) => reader.read(prompt, { typedOnly: true }) };
  let conversationId = options.conversationId;
  let activeConversation: AiConversation | undefined;
  let model = options.model;
  let projectId = options.projectId;
  let savedMode: LocalToolsMode = (await ctx.getDefault("assistant.localTools")) === "off" ? "off" : "ask";
  let localTools: LocalToolsMode = options.noBash ? "off" : options.allowBash ? "ask" : savedMode;
  let modeSource = options.noBash || options.allowBash ? "this session" : savedMode === "off" ? "profile default" : "default";
  let attachments: string[] = [];
  let selectedLocal: LocalSkill[] = [];
  let selectedCloud: AiDraftContentPart[] = [];
  const sessionFolder = createLocalSessionFolder();
  const readContext = createLocalContextReader({
    ctx,
    workspace,
    askTrust: async (found) => {
      const parts: string[] = [];
      if (found.instructionPaths.length)
        parts.push(`AGENTS.md (${found.instructionPaths.length} ${found.instructionPaths.length === 1 ? "file" : "files"})`);
      const count = found.skills.filter((skill) => skill.scope === "project").length;
      if (count) parts.push(`${count} Skills in .agents/skills`);
      else if (found.hasProjectContext && !parts.length) parts.push("Skills in .agents/skills");
      return selectNumberedChoice({
        output: { print: (line = "") => ctx.error(line), error: (line) => ctx.error(line) },
        reader: choiceReader,
        title: terminalSafeText(`This folder has instructions for the assistant: ${parts.join(", ")}.
They go to the model with every message and can steer what it does with your Cloud data.`),
        prompt: "Choice [Enter = do not load]: ",
        choices: [
          { value: "folder" as const, label: "Trust this folder" },
          { value: "session" as const, label: "Only this session" },
        ],
      });
    },
  });
  const refreshSkills = async () => {
    context = await readContext();
    try {
      cloudSkills = (await readApi<{ skills: AiSkillSummary[] }>(ctx, "/skills")).skills.filter((skill) => skill.enabled);
    } catch {
      cloudSkills = [];
    }
    return context;
  };
  const skillCounts = () => {
    const project = context.skills.filter((skill) => skill.scope === "project").length;
    const global = context.skills.length - project;
    return [project ? `${project} project` : "", global ? `${global} global` : ""].filter(Boolean).join(", ");
  };
  const instructionsSummary = () =>
    !context.instructionPaths.length
      ? "none"
      : !context.trusted
        ? "not loaded"
        : `${context.instructions.length} ${context.instructions.length === 1 ? "file" : "files"}${context.shortened ? ", shortened" : ""}`;
  const clientTools: AssistantClientTools = {
    names: new Set(["local_bash", ...AI_LOCAL_TOOL_NAMES]),
    run: async (call, signal) =>
      runLocalTool(
        call,
        {
          ctx,
          workspace,
          conversationId: conversationId!,
          mode: localTools,
          skills: context.skills,
          freeReadRoots: context.skills.map((skill) => skill.directory),
          sessionFolder,
          ask: async (lines, question) => {
            if (signal.aborted) return false;
            for (const line of lines) ctx.error(terminalSafeText(line));
            return (await readApproval(reader, terminalSafeText(question))) === "once" && !signal.aborted;
          },
          printBash: (stdout, stderr, truncated) => {
            if (stdout) ctx.error(terminalSafeText(stdout.trimEnd()));
            if (stderr) ctx.error(terminalSafeText(stderr.trimEnd()));
            if (truncated) ctx.error("[Local Bash output truncated]");
          },
        },
        signal,
      ),
  };
  const readSelectedSkill = (skill: LocalSkill) =>
    readSelectedLocalSkill({
      skill,
      context,
      workspace,
      ask: async (question) => (await readApproval(reader, question)) === "once",
    });
  const preparedAttachments = new Map<string, Awaited<ReturnType<typeof uploadAttachment>>>();
  let activeAbort: AbortController | null = null;
  let exitRequested = false;
  const removeInterrupt = reader.onInterrupt((question) => {
    if (activeAbort) activeAbort.abort();
    else if (!question) {
      exitRequested = true;
      reader.close();
    }
  });

  const attachLocalFile = async (path: string): Promise<void> => {
    let target: string;
    try {
      target = realpathSync(resolveLocalPath(path, workspace));
      if (!statSync(target).isFile()) throw new Error("Not a file");
    } catch {
      throw new Error(`Attachment not found: ${terminalSafeText(path)}`);
    }
    if (attachments.some((attached) => realpathSync(resolveLocalPath(attached, workspace)) === target)) return;
    const access = classifyLocalPath(path, { workspace });
    if (access.access === "blocked") {
      ctx.error(`Not attached: ${terminalSafeText(path)} is cld's configuration.`);
      return;
    }
    if (access.access === "ask") {
      const question =
        access.reason === "home"
          ? `Attach ${terminalSafeText(path)}? You started cld in your home folder or above, so every file asks first.`
          : access.reason === "protected"
            ? `Attach ${terminalSafeText(path)}? It may contain secrets.`
            : `Attach ${terminalSafeText(path)}? It is outside ${terminalSafeText(workspace)}.`;
      const answer = await readApproval(reader, question);
      if (answer !== "once") {
        ctx.print(`Not attached: ${terminalSafeText(path)}`);
        return;
      }
    }
    await validateLocalAttachments([...attachments, target]);
    attachments.push(target);
  };

  const runTurn = async (input: { path: string; body: unknown } | { turnId: string }): Promise<number> => {
    if (!conversationId) return 0;
    const chatId = conversationId;
    const resuming = "turnId" in input;
    const output = createAssistantTurnOutput();
    const abort = new AbortController();
    let turnId = resuming ? input.turnId : undefined;
    activeAbort = abort;
    try {
      let result: AssistantTurnStreamResult | undefined;
      if ("turnId" in input) {
        result = await streamAssistantTurn({
          ctx,
          conversationId: chatId,
          turnId,
          output,
          clientTools,
          signal: abort.signal,
          onCapabilityApproval: (request) => collectCapabilityApproval(ctx, reader, request),
        });
      } else {
        const submission = await submitAssistantTurn({
          ctx,
          conversationId: chatId,
          path: input.path,
          body: input.body,
          watch: true,
          onSubmitted: (submitted) => {
            turnId = submitted.turn.id;
            if (input.path.endsWith("/turns")) {
              attachments = [];
              preparedAttachments.clear();
              selectedLocal = [];
              selectedCloud = [];
            }
          },
          output,
          clientTools,
          signal: abort.signal,
          onCapabilityApproval: (request) => collectCapabilityApproval(ctx, reader, request),
        });
        turnId = submission.submitted.turn.id;
        result = submission.result;
      }
      if (result?.status === "needs_attention" && result.turnId) {
        result =
          (await resolveAttention({
            ctx,
            reader,
            conversationId: chatId,
            turnId: result.turnId,
            output,
            signal: abort.signal,
            clientTools,
          })) ?? undefined;
        if (!result && !abort.signal.aborted) return 2;
      }
      if (result?.status === "aborted" || (!result && abort.signal.aborted)) {
        if (turnId) await readApi(ctx, conversationPath(chatId, `/turns/${encodeURIComponent(turnId)}/abort`), { method: "POST" });
        printInfo(ctx, "Turn stopped.");
        return resuming ? 130 : 0;
      }
      if (result?.status === "failed") ctx.error(terminalSafeText(result.error || "Assistant turn failed."));
      return 0;
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        if (turnId) await readApi(ctx, conversationPath(chatId, `/turns/${encodeURIComponent(turnId)}/abort`), { method: "POST" });
        printInfo(ctx, "Turn stopped.");
        return resuming ? 130 : 0;
      }
      if (resuming) throw error;
      ctx.error(terminalSafeText(error instanceof Error ? error.message : String(error)));
      return 0;
    } finally {
      activeAbort = null;
    }
  };

  const openChat = async (id: string): Promise<number> => {
    const detail = await readConversationDetail(ctx, id);
    activeConversation = detail.conversation;
    conversationId = detail.conversation.id;
    projectId = detail.conversation.projectId ?? undefined;
    preparedAttachments.clear();
    printInfo(ctx, `Chat: ${detail.conversation.title} (${conversationId})`);
    return detail.activeTurn ? runTurn({ turnId: detail.activeTurn.turnId }) : 0;
  };

  const localClientInput = async () => {
    context = await readContext();
    return localTurnFields({ context, localTools, workspace, client: { kind: "cli" } });
  };

  const send = async (message: string): Promise<number> => {
    const clientInput = await localClientInput();
    for (const path of extractMessageAttachments(message, workspace)) {
      const count = attachments.length;
      await attachLocalFile(path);
      if (attachments.length > count) printInfo(ctx, `Attached: ${basename(path)}`);
    }
    await validateLocalAttachments(attachments);
    if (!activeConversation) activeConversation = await resolveConversation(ctx, { conversationId, title: options.title, projectId });
    const conversation = activeConversation;
    if (!conversationId) {
      conversationId = conversation.id;
      printResumeHint(ctx, conversation.id, true);
    }
    for (const path of attachments) {
      if (!preparedAttachments.has(path)) preparedAttachments.set(path, await uploadAttachment(ctx, conversation.id, path));
    }
    const content = [...attachments.map((path) => preparedAttachments.get(path)!), ...selectedCloud];
    const selectedSkills = [];
    if (localTools === "ask") {
      for (const selected of selectedLocal) {
        const skill = context.skills.find((skill) => skill.name === selected.name && skill.directory === selected.directory);
        if (skill) {
          const loaded = await readSelectedSkill(skill);
          if (loaded) selectedSkills.push(loaded);
        }
      }
    }
    return runTurn({
      path: conversationPath(conversation.id, "/turns"),
      body: {
        message,
        ...(content.length > 0 ? { content } : {}),
        ...(model ? { modelProfileId: model } : {}),
        ...clientInput,
        localContext: {
          ...clientInput.localContext,
          selectedSkills,
        },
      },
    });
  };

  const handleCommand = async (name: string, value: string): Promise<number> => {
    switch (name) {
      case "/help":
        printInteractiveHelp(ctx);
        break;
      case "/exit":
        exitRequested = true;
        break;
      case "/new":
        if (conversationId) printResumeHint(ctx, conversationId);
        conversationId = undefined;
        activeConversation = undefined;
        preparedAttachments.clear();
        printInfo(ctx, "The next message starts a new chat.");
        break;
      case "/resume": {
        let selected = value || undefined;
        if (!selected) {
          const chats = await readApi<AiConversation[]>(ctx, "/conversations?limit=20");
          const dates = new Intl.DateTimeFormat(ctx.options.locale, { dateStyle: "medium", timeStyle: "short" });
          selected = await selectNumberedChoice({
            output: ctx,
            reader: choiceReader,
            title: "Open a chat:",
            prompt: "Chat [Enter to cancel]: ",
            choices: chats.map((chat) => ({
              value: chat.id,
              label: chat.title,
              current: chat.id === conversationId,
              description:
                chat.runStatus === "running" || chat.runStatus === "queued"
                  ? "running"
                  : chat.runStatus === "needs_attention" || chat.runStatus === "waiting_for_browser"
                    ? "needs attention"
                    : chat.runStatus === "failed"
                      ? "failed"
                      : chat.unreadCompletion
                        ? "unread"
                        : dates.format(new Date(chat.updatedAt)),
            })),
            emptyMessage: "No recent chats.",
          });
        }
        // Ctrl+C stops an attached turn but keeps the session open.
        if (!selected) break;
        const code = await openChat(selected);
        return code === 130 ? 0 : code;
      }
      case "/project": {
        const { projects } = await readProjectsApi<{ projects: AiProject[] }>(ctx, "/");
        const current = activeConversation ? activeConversation.projectId : projectId;
        const selected = value
          ? value === "none"
            ? null
            : value
          : await selectNumberedChoice<string | null>({
              output: ctx,
              reader: choiceReader,
              title: "Select a Project:",
              prompt: "Project [Enter to cancel]: ",
              zeroChoice: { value: null, label: "No Project", current: !current },
              choices: projects.map((project) => ({
                value: project.shortId,
                label: project.name,
                description: project.description.replaceAll(/\s+/g, " ").trim(),
                current: current === project.shortId,
              })),
            });
        if (selected === undefined) break;
        const project = projects.find((project) => project.shortId === selected);
        if (conversationId) {
          activeConversation = await readApi<AiConversation>(
            ctx,
            conversationPath(conversationId, "/project"),
            jsonRequest("PUT", { projectId: selected }),
          );
        } else if (selected !== null && !project) {
          throw new Error(`Project not found: ${selected}`);
        }
        projectId = selected ?? undefined;
        printInfo(ctx, `Project: ${selected === null ? "none" : (project?.name ?? selected)}`);
        break;
      }
      case "/model": {
        if (value) {
          model = value === "default" ? undefined : value;
          printInfo(ctx, model ? `Model: ${model}` : "Model: default");
          break;
        }
        const models = await readApi<AiPublicModelProfile[]>(ctx, "/models");
        const selected = await selectNumberedChoice<string | null>({
          output: ctx,
          reader: choiceReader,
          title: "Select a model:",
          prompt: "Model [Enter to cancel]: ",
          zeroChoice: { value: null, label: "Cloud default", current: !model },
          choices: models.map((profile) => ({
            value: profile.id,
            label: profile.label,
            description: `${profile.provider} · ${profile.model}`,
            current: model === profile.id,
          })),
          emptyMessage: "No selectable models are available.",
        });
        if (selected !== undefined) {
          model = selected ?? undefined;
          const label = model ? (models.find((profile) => profile.id === model)?.label ?? model) : undefined;
          printInfo(ctx, label ? `Model: ${label}` : "Model: default");
        }
        break;
      }
      case "/retry": {
        if (value && value !== "retry" && value !== "details" && value !== "concise")
          throw new Error("Use /retry, /retry retry, /retry details, or /retry concise.");
        if (!conversationId) {
          ctx.print("Nothing to answer again yet.");
          break;
        }
        const detail = await readApi<{ messages: AiStoredMessage[]; hasMoreMessages: boolean }>(ctx, conversationPath(conversationId));
        let { messages, hasMoreMessages: hasMore } = detail;
        let message = messages.findLast((stored) => stored.kind === "message" && stored.message.role === "user");
        while (!message && hasMore && messages.length > 0) {
          const before = Math.min(...messages.map((stored) => stored.seq));
          const page = await readApi<{ messages: AiStoredMessage[]; hasMore: boolean }>(
            ctx,
            conversationPath(conversationId, `/messages?before=${before}&limit=200`),
          );
          messages = page.messages;
          hasMore = page.hasMore;
          message = messages.findLast((stored) => stored.kind === "message" && stored.message.role === "user");
        }
        if (!message) {
          ctx.print("Nothing to answer again yet.");
          break;
        }
        const mode =
          value ||
          (await selectNumberedChoice({
            output: ctx,
            reader: choiceReader,
            title: "Answer again:",
            prompt: "Choice [Enter to cancel]: ",
            choices: [
              { value: "retry", label: "Try again" },
              { value: "details", label: "More detailed" },
              { value: "concise", label: "More concise" },
            ],
          }));
        if (mode) {
          const clientInput = await localClientInput();
          return runTurn({
            path: conversationPath(conversationId, `/messages/${encodeURIComponent(message.id)}/retry`),
            body: {
              mode,
              ...(model ? { modelProfileId: model } : {}),
              ...clientInput,
              clientToolIds: [...clientInput.clientToolIds, "code_open", "code_secret"],
            },
          });
        }
        break;
      }
      case "/files": {
        if (!conversationId) ctx.print("No chat files yet.");
        else {
          const files = await readApi<FileList>(ctx, conversationPath(conversationId, "/files"));
          if (files.files.length === 0) ctx.print("No chat files yet.");
          else files.files.forEach((file) => ctx.print(`${terminalSafeText(file.path)}\t${file.size}`));
        }
        break;
      }
      case "/attach": {
        if (!value) throw new Error("Attachment not found: <path>");
        const count = attachments.length;
        await attachLocalFile(value);
        if (attachments.length > count) printInfo(ctx, `Attached for next message: ${basename(value)}`);
        break;
      }
      case "/web": {
        const url = new URL(`${ctx.options.server.replace(/\/+$/, "")}/app/assistant`);
        if (conversationId) url.searchParams.set("conversation", conversationId);
        ctx.print(url.href);
        if (await ctx.openUrl?.(url.href)) printInfo(ctx, "Opened in your browser.");
        break;
      }
      case "/skills": {
        await refreshSkills();
        const localNames = new Map(context.skills.map((skill) => [skill.name, skill]));
        const visibleCloud = cloudSkills.filter((skill) => !localNames.has(skill.name));
        if (!context.skills.length && !visibleCloud.length && !context.hidden.length && !context.problems.length) {
          ctx.print("No Skills found. Local Skills live in .agents/skills or ~/.agents/skills.");
          break;
        }
        ctx.print("Skills · /<name> selects one for your next message");
        const preview = (description: string) => {
          const line = description.replaceAll(/\s+/g, " ").trim();
          return line.length > 72 ? `${line.slice(0, 71)}…` : line;
        };
        const width = Math.max(1, ...skillNames().map((name) => name.length));
        for (const skill of context.skills)
          ctx.print(
            terminalSafeText(
              `  ${skill.name.padEnd(width)}  ${skill.scope.padEnd(7)}  ${preview(skill.description)}${skill.manualOnly ? ` (only with /${skill.name})` : ""}`,
            ),
          );
        for (const skill of visibleCloud)
          ctx.print(
            terminalSafeText(
              `  ${skill.name.padEnd(width)}  Cloud    ${preview(skill.description)}${skill.manualOnly ? ` (only with /${skill.name})` : ""}`,
            ),
          );
        const hidden = [
          ...context.hidden,
          ...cloudSkills
            .filter((skill) => localNames.has(skill.name))
            .map((skill) => ({ name: skill.name, scope: "Cloud", reason: `hidden by the ${localNames.get(skill.name)!.scope} Skill` })),
        ];
        if (hidden.length) {
          ctx.print("Hidden");
          for (const skill of hidden)
            ctx.print(terminalSafeText(`  ${skill.name.padEnd(width)}  ${skill.scope.padEnd(7)}  ${skill.reason}`));
        }
        if (context.problems.length) {
          ctx.print("Problems");
          for (const problem of context.problems) ctx.print(terminalSafeText(`  ${problem.path}  ${problem.error}`));
        }
        break;
      }
      case "/status": {
        await refreshSkills();
        const selectedProject = activeConversation ? activeConversation.projectId : projectId;
        const projects = selectedProject ? (await readProjectsApi<{ projects: AiProject[] }>(ctx, "/")).projects : [];
        const project = projects.find((project) => project.shortId === selectedProject);
        const rows: Array<[string, string]> = [
          ["Profile", `${ctx.options.profile} · ${ctx.options.server}`],
          [
            "Chat",
            conversationId
              ? `${conversationId} · ${activeConversation?.title ?? conversationId}`
              : "none yet · the next message starts one",
          ],
          ["Model", await readInitialModelLabel(ctx, model)],
          ["Project", selectedProject ? `${project?.name ?? selectedProject} (${selectedProject})` : "none"],
          ["Local tools", `${localTools} (${modeSource}) · ${workspace}`],
          [
            "AGENTS.md",
            !context.instructionPaths.length
              ? "none"
              : context.trusted
                ? context.instructions.map((file) => file.path).join(", ")
                : "not loaded (folder not trusted)",
          ],
          ["Skills", `${[skillCounts(), `${cloudSkills.length} Cloud`].filter(Boolean).join(", ")} · /skills lists them`],
        ];
        for (const [label, value] of rows) ctx.print(`${label.padEnd(13)}${terminalSafeText(value)}`);
        break;
      }
      case "/usage": {
        const quota = await readApi<AiChatQuotaSnapshot>(ctx, "/quotas");
        if (!quota.enabled) {
          ctx.print("No usage limits apply.");
          break;
        }
        const models = await readApi<AiPublicModelProfile[]>(ctx, "/models");
        const label = (id: string) => models.find((model) => model.id === id)?.label ?? id;
        const dates = new Intl.DateTimeFormat(ctx.options.locale, { dateStyle: "medium", timeStyle: "short" });
        for (const balance of quota.balances) {
          const usage = balance.unlimited ? "no limit" : balance.usedPercent === null ? "usage unknown" : `${balance.usedPercent}% used`;
          const reset = !balance.unlimited && balance.resetsAt ? ` · resets ${dates.format(new Date(balance.resetsAt))}` : "";
          ctx.print(terminalSafeText(`${balance.scope === "*" ? "All models" : label(balance.scope)}  ${usage}${reset}`));
        }
        if (quota.unlimitedModels?.length) ctx.print(terminalSafeText(`Not counted: ${quota.unlimitedModels.map(label).join(", ")}`));
        break;
      }
      case "/permissions": {
        try {
          if (value && value !== "ask" && value !== "off") {
            ctx.error("Use /permissions, /permissions ask, or /permissions off.");
            break;
          }
          const selected =
            value === "ask" || value === "off"
              ? value
              : await selectNumberedChoice<LocalToolsMode>({
                  output: ctx,
                  reader: choiceReader,
                  title: terminalSafeText(
                    `Local tools · run in ${workspace} as your OS user · results are stored in this chat and sent to the model`,
                  ),
                  prompt: "Choice [Enter to cancel]: ",
                  choices: [
                    {
                      value: "ask",
                      label: "ask",
                      description:
                        "list, read, upload, and create files here freely; ask before commands, changing or moving files, and other folders",
                      current: localTools === "ask",
                    },
                    { value: "off", label: "off", description: "do not offer local tools to the model", current: localTools === "off" },
                  ],
                });
          if (selected === undefined) break;
          localTools = selected;
          modeSource = "this session";
          printInfo(ctx, `Local tools: ${selected} for this session.`);
          if (!value && selected !== savedMode) {
            const answer = await readChoice(
              reader,
              `Save as default for profile "${terminalSafeText(ctx.options.profile)}"? [y/N]: `,
              ["y", "yes", "n", "no"],
              "n",
            );
            if (answer === "y" || answer === "yes") {
              await ctx.setDefault("assistant.localTools", selected === "off" ? "off" : undefined);
              savedMode = selected;
              printInfo(ctx, `Saved ${selected} as the default for profile "${ctx.options.profile}".`);
            }
          }
        } catch (error) {
          ctx.error(terminalSafeText(error instanceof Error ? error.message : String(error)));
        } finally {
          ctx.print("Cloud approvals: /approvals");
        }
        break;
      }
      case "/approvals": {
        const everywhere = await readApprovalPreferences(ctx);
        const chat = conversationId ? await readApprovalPreferences(ctx, conversationId) : { approvals: [] };
        const approvals = [...everywhere.approvals, ...chat.approvals];
        const selected = value
          ? approvals.find((approval) => approval.id === value)
          : await selectNumberedChoice({
              output: ctx,
              reader: choiceReader,
              title: "Remembered Cloud approvals:",
              prompt: "Revoke [Enter to cancel]: ",
              choices: approvals.map((approval) => ({
                value: approval,
                label: approval.title,
                description: `${approval.website ? "Website" : (approval.app?.name ?? "Cloud AI tool")} · ${approval.conversationId ? "this chat" : "everywhere"}`,
              })),
              emptyMessage: "No remembered Cloud approvals.",
            });
        if (value && !selected) throw new Error(`Approval not found: ${value}`);
        if (selected) {
          await revokeApprovalPreference(ctx, selected.id);
          printInfo(ctx, `Revoked: ${selected.title} (${selected.conversationId ? "this chat" : "everywhere"}).`);
        }
        break;
      }
      default: {
        await refreshSkills();
        const skillName = name.slice(1);
        const local = context.skills.find((skill) => skill.name === skillName);
        const cloud = cloudSkills.find((skill) => skill.name === skillName);
        if (local) {
          if (localTools === "off") {
            ctx.error("Local tools are off in this session.");
            break;
          }
          if (!selectedLocal.some((skill) => skill.name === local.name)) {
            if (selectedLocal.length >= AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS)
              throw new Error("At most 4 local Skills can be selected for one message.");
            selectedLocal.push(local);
          }
        } else if (cloud) {
          if (!selectedCloud.some((part) => part.type === "resource" && part.ref.id === cloud.shortId))
            selectedCloud.push({ type: "resource", ref: { type: "core.ai.skill", id: cloud.shortId }, title: cloud.name });
        } else {
          ctx.error(`Unknown command ${terminalSafeText(name)}. Type /help for the list.`);
          break;
        }
        if (value) return send(value);
        printInfo(ctx, `Skill ${skillName} is selected for your next message.`);
        break;
      }
    }
    return 0;
  };

  try {
    ctx.print(terminalSafeText(`Assistant · ${await readInitialModelLabel(ctx, model)} · /help for commands`));
    context = await refreshSkills();
    const workspaceAccess = classifyLocalPath(workspace, { workspace });
    const instructions = context.instructionPaths.length ? ` · AGENTS.md: ${instructionsSummary()}` : "";
    const skills = context.skills.length ? ` · Skills: ${skillCounts()}` : "";
    printInfo(
      ctx,
      localTools === "ask"
        ? `Local tools: ask · ${workspace}${instructions}${skills}`
        : `Local tools: off${instructions} · /permissions to change.`,
    );
    if (localTools === "ask")
      printInfo(
        ctx,
        workspaceAccess.access === "ask" && workspaceAccess.reason === "home"
          ? `${workspace} is your home folder or above, so every file access asks first. /permissions to change.`
          : "Reads and creates files here freely; asks before commands, changing or moving files, and other folders. What it reads is stored in this chat and sent to the model. /permissions to change.",
      );
    for (const path of options.attachments ?? []) await attachLocalFile(path);
    if (conversationId) {
      const code = await openChat(conversationId);
      if (code !== 0) return code;
    }
    if (options.initialPrompt?.trim()) {
      try {
        const code = await send(options.initialPrompt.trim());
        if (code !== 0) return code;
      } catch (error) {
        ctx.error(terminalSafeText(error instanceof Error ? error.message : String(error)));
      }
    }
    while (!exitRequested) {
      const line = await reader.readMessage("> ");
      if (line === null) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const firstWord = trimmed.split(/\s+/, 1)[0]!;
        const code = /^\/[a-z0-9-]+$/.test(firstWord)
          ? await handleCommand(firstWord, trimmed.slice(firstWord.length).trim())
          : await send(trimmed);
        if (code !== 0) return code;
      } catch (error) {
        ctx.error(terminalSafeText(error instanceof Error ? error.message : String(error)));
      }
    }
    return 0;
  } finally {
    try {
      await closeCliCodeHost(ctx);
    } finally {
      try {
        await sessionFolder.close();
      } finally {
        if (activeConversation) printResumeHint(ctx, activeConversation.id);
        removeInterrupt();
        reader.close();
      }
    }
  }
};

export const assistantRootCommand = command("", {
  summary: "Chat with Assistant",
  args: { prompt: arg.rest({ valueLabel: "message" }) },
  flags: {
    print: flag.boolean({ name: "print", aliases: ["p"], description: "Print one response and exit" }),
    chat: flag.string({ description: "Continue an existing chat ID" }),
    title: flag.string({ description: "Title for a new chat" }),
    model: flag.string({ description: "Model profile ID" }),
    project: flag.string({ description: "Create a new chat in this Project ID" }),
    attach: flag.stringList({ description: "Attach a local file; repeat for multiple files" }),
    approve: flag.stringList({ description: "Approve this exact tool name in print mode; repeat as needed" }),
    allowBash: flag.boolean({ description: "Offer local tools in this session, asking before every command" }),
    noBash: flag.boolean({ description: "Do not offer local tools in this session" }),
    detach: flag.boolean({ description: "Submit without waiting in print mode" }),
  },
  examples: [
    "cld assistant",
    'cld assistant "Summarize my open work"',
    'cld assistant -p "Summarize my open work"',
    'cld assistant -p --chat <id> --attach report.pdf "What matters here?"',
  ],
  async run({ ctx, args, flags }) {
    if (flags.attach.length > AI_TURN_ATTACHMENT_MAX_ITEMS) {
      throw new Error(`At most ${AI_TURN_ATTACHMENT_MAX_ITEMS} attachments can be sent with one message.`);
    }
    if (flags.allowBash && flags.noBash) throw new Error("Pass either --allow-bash or --no-bash.");
    const positional = args.prompt.join(" ").trim();
    if (!flags.print) {
      if (ctx.options.output !== "text") throw new Error("--json and --jsonl require --print.");
      if (flags.detach) throw new Error("--detach requires --print.");
      if (flags.approve.length > 0) throw new Error("--approve requires --print.");
      if (!process.stdin.isTTY) throw new Error("Interactive chat requires a terminal. Use --print for piped input.");
      return runInteractiveAssistant(ctx, {
        conversationId: flags.chat,
        title: flags.title,
        model: flags.model,
        projectId: flags.project,
        attachments: flags.attach,
        initialPrompt: positional || undefined,
        allowBash: flags.allowBash,
        noBash: flags.noBash,
      });
    }

    if (flags.allowBash) throw new Error("--allow-bash is available only in interactive mode.");
    if (flags.noBash) throw new Error("--no-bash is available only in interactive mode.");

    const piped = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
    if (positional && piped) throw new Error("Pass the message either as arguments or through stdin.");
    const message = positional || piped;
    if (!message) throw new Error("Missing message.");
    await validateLocalAttachments(flags.attach);
    const conversation = await resolveConversation(ctx, { conversationId: flags.chat, title: flags.title, projectId: flags.project });
    const content = [];
    for (const path of flags.attach) content.push(await uploadAttachment(ctx, conversation.id, path));
    const { submitted, result } = await submitAssistantTurn({
      ctx,
      conversationId: conversation.id,
      path: conversationPath(conversation.id, "/turns"),
      body: {
        message,
        ...(content.length > 0 ? { content } : {}),
        ...(flags.model ? { modelProfileId: flags.model } : {}),
      },
      watch: !flags.detach,
      approveTools: flags.approve,
    });
    if (!result) {
      if (ctx.options.output === "json") ctx.json(submitted);
      else if (ctx.options.output === "jsonl") ctx.jsonLine(submitted);
      else ctx.print(submitted.turn.id);
      return 0;
    }
    if (ctx.options.output === "json") ctx.json(result);
    if (result.status === "failed") throw new Error(result.error || "Assistant turn failed.");
    if (result.status === "needs_attention") {
      if (ctx.options.output === "text") {
        ctx.error(`Turn ${result.turnId} needs attention. Run \`cld assistant actions list ${conversation.id} ${result.turnId}\`.`);
      }
      return 2;
    }
    return result.status === "aborted" ? 130 : 0;
  },
});
