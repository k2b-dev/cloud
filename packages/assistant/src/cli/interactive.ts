import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import type {
  AiConversation,
  AiFileStat,
  AiPendingTurnAction,
  AiProject,
  AiPublicModelProfile,
  AiStoredMessage,
  CloudAiSurveyInput,
  CloudAiTextEditorInput,
} from "@k2b/cloud/ai";
import { AI_TURN_ATTACHMENT_MAX_ITEMS, CloudAiSurveyInputSchema, CloudAiTextEditorInputSchema } from "@k2b/cloud/ai/browser";
import { arg, type CloudCliContext, command, flag } from "@k2b/cloud/cli";
import type { AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { httpApprovalNotice } from "../artifacts/code-approval-message";
import type { CapabilityDecision, CodeApproval } from "../artifacts/runtime/capabilities";
import { readApprovalPreferences, revokeApprovalPreference } from "./approvals";
import { closeCliCodeHost } from "./code-host";
import { createLineReader, type LineReader } from "./line-reader";
import { deniedLocalBashResult, parseLocalBashInput, runLocalBash } from "./local-bash";
import { classifyLocalPath, completeLocalPath, extractMessageAttachments, resolveLocalPath } from "./local-paths";
import { jsonRequest, readApi, readProjectsApi } from "./shared";
import { type AssistantTurnOutput, type AssistantTurnStreamResult, createAssistantTurnOutput, streamAssistantTurn } from "./stream";
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
export const completeInteractiveLine = (line: string, cwd: string): [string[], string] => {
  if (line.startsWith("/") && !/\s/.test(line)) {
    return [INTERACTIVE_COMMANDS.map((command) => command.name).filter((name) => name.startsWith(line)), line];
  }
  const token = line.startsWith("/attach ") ? line.slice(8) : (line.split(/\s+/).at(-1) ?? "");
  return [line.startsWith("/attach ") || token.startsWith("@") ? completeLocalPath(token, cwd) : [], token];
};

const printInteractiveHelp = (ctx: CloudCliContext): void => {
  const width = Math.max(...INTERACTIVE_COMMANDS.map((command) => command.usage.length)) + 3;
  for (const command of INTERACTIVE_COMMANDS) ctx.print(`${command.usage.padEnd(width)}${command.summary}`);
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
  localTools: LocalToolsMode;
  workspace: string;
  setStreaming: (streaming: boolean) => void;
  output: AssistantTurnOutput;
}): Promise<AssistantTurnStreamResult | null> => {
  let result = { status: "needs_attention" as const, turnId: input.turnId };
  while (result.status === "needs_attention") {
    const actions = await readApi<AiPendingTurnAction[]>(
      input.ctx,
      conversationPath(input.conversationId, `/pending-actions/${encodeURIComponent(input.turnId)}`),
    );
    const action = actions[0];
    if (!action) return null;

    if (action.type === "approval_request") {
      input.ctx.print(terminalSafeText(`Approval required: ${action.message ?? action.name}`));
      input.ctx.print(approvalInputPreview(action.args));
      const decision = await collectActionApproval(input.ctx, input.reader, action);
      if (decision === null) return null;
      await submitAction(input.ctx, action, { type: "approval_response", ...decision });
    } else if (action.name === "local_bash" && input.localTools === "off") {
      await submitAction(input.ctx, action, { type: "tool_result", result: deniedLocalBashResult("Local tools are off in this session.") });
    } else if (action.name === "local_bash") {
      const bash = parseLocalBashInput(action.args);
      if (!bash) {
        input.ctx.error("The local Bash request has invalid arguments and was left pending.");
        return null;
      }
      input.ctx.error(`Bash wants to run in ${input.workspace}:`);
      input.ctx.error("");
      input.ctx.error(`  ${terminalSafeText(bash.command)}`);
      input.ctx.error("");
      const answer = await readApproval(input.reader, "Run?");
      if (answer === null) return null;
      const bashResult =
        answer === "once" ? await runLocalBash(bash.command, { cwd: input.workspace, signal: input.signal }) : deniedLocalBashResult();
      if (bashResult.stdout) input.ctx.error(terminalSafeText(bashResult.stdout.trimEnd()));
      if (bashResult.stderr) input.ctx.error(terminalSafeText(bashResult.stderr.trimEnd()));
      if (bashResult.truncated) input.ctx.error("[Local Bash output truncated]");
      await submitAction(input.ctx, action, { type: "tool_result", result: bashResult });
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
      input.ctx.error(`Frontend tool ${action.name} needs a result.`);
      input.ctx.error(
        `Run \`cld assistant actions submit ${input.conversationId} ${input.turnId} ${action.callId} --result-file <file>\`.`,
      );
      return null;
    }

    input.setStreaming(true);
    const streamed = await streamAssistantTurn({
      ctx: input.ctx,
      conversationId: input.conversationId,
      turnId: input.turnId,
      output: input.output,
      signal: input.signal,
      onCapabilityApproval: (request) => collectCapabilityApproval(input.ctx, input.reader, request),
    }).finally(() => input.setStreaming(false));
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
  ctx.print(terminalSafeText(request.review?.message ?? request.title));
  ctx.print(approvalInputPreview(request.input));
  const decision = await collectActionApproval(ctx, reader, request);
  return decision?.remember === "always" ? { approved: true, remember: "always" } : { approved: decision?.approved === true };
}

export const runInteractiveAssistant = async (
  ctx: CloudCliContext,
  options: InteractiveOptions,
  suppliedReader?: LineReader,
): Promise<number> => {
  if (options.allowBash && options.noBash) throw new Error("Pass either --allow-bash or --no-bash.");
  const workspace = process.cwd();
  const reader = suppliedReader ?? createLineReader({ cwd: workspace, completer: (line) => completeInteractiveLine(line, workspace) });
  const choiceReader = { read: (prompt: string) => reader.read(prompt, { typedOnly: true }) };
  let conversationId = options.conversationId;
  let activeConversation: AiConversation | undefined;
  let model = options.model;
  let projectId = options.projectId;
  let savedMode: LocalToolsMode = (await ctx.getDefault("assistant.localTools")) === "off" ? "off" : "ask";
  let localTools: LocalToolsMode = options.noBash ? "off" : options.allowBash ? "ask" : savedMode;
  let modeSource = options.noBash || options.allowBash ? "this session" : savedMode === "off" ? "profile default" : "default";
  let attachments = [...(options.attachments ?? [])];
  const preparedAttachments = new Map<string, Awaited<ReturnType<typeof uploadAttachment>>>();
  let activeAbort: AbortController | null = null;
  let streaming = false;
  let exitRequested = false;
  const removeInterrupt = reader.onInterrupt(() => {
    if (activeAbort && streaming) activeAbort.abort();
    else {
      exitRequested = true;
      activeAbort?.abort();
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
    const access = classifyLocalPath(target, { workspace });
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
      streaming = true;
      let result: AssistantTurnStreamResult | undefined;
      if ("turnId" in input) {
        result = await streamAssistantTurn({
          ctx,
          conversationId: chatId,
          turnId,
          output,
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
          output,
          signal: abort.signal,
          onCapabilityApproval: (request) => collectCapabilityApproval(ctx, reader, request),
        });
        turnId = submission.submitted.turn.id;
        result = submission.result;
        if (input.path.endsWith("/turns")) {
          attachments = [];
          preparedAttachments.clear();
        }
      }
      streaming = false;
      if (result?.status === "needs_attention" && result.turnId) {
        result =
          (await resolveAttention({
            ctx,
            reader,
            conversationId: chatId,
            turnId: result.turnId,
            output,
            signal: abort.signal,
            localTools,
            workspace,
            setStreaming: (value) => {
              streaming = value;
            },
          })) ?? undefined;
        if (!result) return 2;
      }
      if (result?.status === "aborted") {
        if (turnId) await readApi(ctx, conversationPath(chatId, `/turns/${encodeURIComponent(turnId)}/abort`), { method: "POST" });
        printInfo(ctx, "Turn stopped.");
        return resuming ? 130 : 0;
      }
      if (result?.status === "failed") ctx.error(result.error || "Assistant turn failed.");
      return 0;
    } catch (error) {
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        if (turnId) await readApi(ctx, conversationPath(chatId, `/turns/${encodeURIComponent(turnId)}/abort`), { method: "POST" });
        printInfo(ctx, "Turn stopped.");
        return resuming ? 130 : 0;
      }
      if (resuming) throw error;
      ctx.error(error instanceof Error ? error.message : String(error));
      return 0;
    } finally {
      streaming = false;
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

  const send = async (message: string): Promise<number> => {
    for (const path of extractMessageAttachments(message, workspace)) await attachLocalFile(path);
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
    const content = attachments.map((path) => preparedAttachments.get(path)!);
    return runTurn({
      path: conversationPath(conversation.id, "/turns"),
      body: {
        message,
        ...(content.length > 0 ? { content } : {}),
        ...(model ? { modelProfileId: model } : {}),
        ...(localTools === "ask" ? { clientToolIds: ["local_bash"] } : {}),
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
        const detail = await readApi<{ messages: AiStoredMessage[] }>(ctx, conversationPath(conversationId));
        const message = detail.messages.findLast((stored) => stored.kind === "message" && stored.message.role === "user");
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
        if (mode)
          return runTurn({
            path: conversationPath(conversationId, `/messages/${encodeURIComponent(message.id)}/retry`),
            body: { mode, ...(model ? { modelProfileId: model } : {}) },
          });
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
      case "/status": {
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
                      description: "offer local Bash; ask before every command",
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
          ctx.error(error instanceof Error ? error.message : String(error));
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
                description: `${approval.app?.name ?? "Website"} · ${approval.conversationId ? "this chat" : "everywhere"}`,
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
      default:
        ctx.error(`Unknown command ${name}. Type /help for the list.`);
    }
    return 0;
  };

  try {
    ctx.print(terminalSafeText(`Assistant · ${await readInitialModelLabel(ctx, model)} · /help for commands`));
    const workspaceAccess = classifyLocalPath(workspace, { workspace });
    const homeNotice =
      workspaceAccess.access === "ask" && workspaceAccess.reason === "home"
        ? ` · ${workspace} is your home folder or above, so every @file asks first`
        : "";
    printInfo(
      ctx,
      localTools === "ask"
        ? `Local tools: ask · ${workspace} · Bash runs as your OS user after you confirm each command; commands and output go to this chat and the model. Change with /permissions.${homeNotice}`
        : "Local tools: off · Change with /permissions.",
    );
    if (conversationId) {
      const code = await openChat(conversationId);
      if (code !== 0) return code;
    }
    if (options.initialPrompt?.trim()) {
      try {
        const code = await send(options.initialPrompt.trim());
        if (code !== 0) return code;
      } catch (error) {
        ctx.error(error instanceof Error ? error.message : String(error));
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
        ctx.error(error instanceof Error ? error.message : String(error));
      }
    }
    return 0;
  } finally {
    await closeCliCodeHost(ctx);
    if (activeConversation) printResumeHint(ctx, activeConversation.id);
    removeInterrupt();
    reader.close();
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
