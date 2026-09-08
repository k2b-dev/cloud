import { basename } from "node:path";
import { createInterface } from "node:readline";
import type {
  AiFileStat,
  AiPendingTurnAction,
  AiPublicModelProfile,
  CloudAiSurveyInput,
  CloudAiTextEditorInput,
} from "@valentinkolb/cloud/ai";
import {
  AI_TURN_ATTACHMENT_MAX_ITEMS,
  CloudAiCardInputSchema,
  CloudAiSurveyInputSchema,
  CloudAiTextEditorInputSchema,
} from "@valentinkolb/cloud/ai/browser";
import { arg, type CloudCliContext, command, flag } from "@valentinkolb/cloud/cli";
import { deniedLocalBashResult, parseLocalBashInput, runLocalBash } from "./local-bash";
import { jsonRequest, readApi } from "./shared";
import { type AssistantTurnStreamResult, streamAssistantTurn } from "./stream";
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

type LineReader = {
  read(prompt: string): Promise<string | null>;
  close(): void;
  onInterrupt(handler: () => void): () => void;
  pause?(): void;
  resume?(): void;
};

type InteractiveOptions = {
  conversationId?: string;
  title?: string;
  model?: string;
  projectId?: string;
  attachments?: string[];
  initialPrompt?: string;
  allowBash?: boolean;
};

type FileList = { files: AiFileStat[]; totalBytes: number };
type AssistantStatus = { defaultModelId?: string; models?: AiPublicModelProfile[] };

const createLineReader = (): LineReader => {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let closed = false;
  rl.once("close", () => {
    closed = true;
  });
  return {
    read(prompt) {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          rl.removeListener("close", onClose);
          resolve(value);
        };
        const onClose = () => finish(null);
        rl.once("close", onClose);
        rl.question(prompt, (answer) => finish(answer));
      });
    },
    close: () => rl.close(),
    pause: () => rl.pause(),
    resume: () => rl.resume(),
    onInterrupt(handler) {
      rl.on("SIGINT", handler);
      return () => rl.removeListener("SIGINT", handler);
    },
  };
};

const printInteractiveHelp = (ctx: CloudCliContext): void => {
  ctx.print("/help                 Show these commands");
  ctx.print("/attach <path>        Attach a local file to the next message");
  ctx.print("/files                List files in this chat");
  ctx.print("/model [id|default]   Choose interactively or set the session model");
  ctx.print("/exit                 End the session");
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

const printCard = (ctx: CloudCliContext, args: unknown): void => {
  const card = CloudAiCardInputSchema.safeParse(args);
  if (!card.success) return;
  ctx.print(`${card.data.title}: ${card.data.value}`);
  if (card.data.caption) ctx.print(card.data.caption);
};

const readChoice = async (
  reader: LineReader,
  prompt: string,
  allowed: readonly string[],
  defaultValue?: string,
): Promise<string | null> => {
  while (true) {
    const answer = (await reader.read(prompt))?.trim().toLowerCase();
    if (answer === undefined) return null;
    if (!answer && defaultValue) return defaultValue;
    if (allowed.includes(answer)) return answer;
  }
};

export const collectSurveyResult = async (ctx: CloudCliContext, reader: LineReader, args: unknown): Promise<unknown | null> => {
  const parsed = CloudAiSurveyInputSchema.safeParse(args);
  if (!parsed.success) return null;
  const survey: CloudAiSurveyInput = parsed.data;
  ctx.print(survey.title);
  if (survey.description) ctx.print(survey.description);
  const answers: Record<string, unknown> = {};

  for (const question of survey.questions) {
    if (question.type === "text") {
      while (true) {
        const answer = await reader.read(`${question.label}${question.required ? " *" : ""}: `);
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
        const answer = await reader.read(`${question.label} (${question.min}-${question.max})${question.required ? " *" : ""}: `);
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

    ctx.print(question.label);
    question.options.forEach((option, index) => ctx.print(`  ${index + 1}. ${option.label}`));
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
  reader: LineReader,
  args: unknown,
  edit: (input: CloudAiTextEditorInput) => Promise<unknown> = editTextWithExternalEditor,
): Promise<unknown | null> => {
  const parsed = CloudAiTextEditorInputSchema.safeParse(args);
  if (!parsed.success) return null;
  let input = parsed.data;
  ctx.print(input.title);
  if (input.description) ctx.print(input.description);
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
  allowBash: boolean;
  bashCwd: string;
  setStreaming: (streaming: boolean) => void;
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
      input.ctx.print(`Approval required: ${action.message ?? action.name}`);
      input.ctx.print(JSON.stringify(action.args, null, 2));
      const answer = await readChoice(
        input.reader,
        action.allowAlways ? "Approve? [y/N/a=always]: " : "Approve? [y/N]: ",
        action.allowAlways ? ["y", "yes", "a", "always", "n", "no"] : ["y", "yes", "n", "no"],
        "n",
      );
      if (answer === null) return null;
      const remember = answer === "a" || answer === "always";
      await submitAction(input.ctx, action, {
        type: "approval_response",
        approved: answer === "y" || answer === "yes" || remember,
        ...(remember ? { remember: "always" as const } : {}),
      });
    } else if (action.name === "local_bash" && input.allowBash) {
      const bash = parseLocalBashInput(action.args);
      if (!bash) {
        input.ctx.error("The local Bash request has invalid arguments and was left pending.");
        return null;
      }
      input.ctx.error(`Bash wants to run in ${input.bashCwd}:`);
      input.ctx.error("");
      input.ctx.error(`  ${terminalSafeText(bash.command)}`);
      input.ctx.error("");
      const answer = await readChoice(input.reader, "Run? [y/N]: ", ["y", "yes", "n", "no"], "n");
      if (answer === null) return null;
      const bashResult =
        answer === "y" || answer === "yes"
          ? await runLocalBash(bash.command, { cwd: input.bashCwd, signal: input.signal })
          : deniedLocalBashResult();
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
      signal: input.signal,
      onToolBlock: (block) => {
        if (block.name === "card" && block.status === "completed") printCard(input.ctx, block.args);
      },
    }).finally(() => input.setStreaming(false));
    if (streamed.status !== "needs_attention") return streamed.status === "idle" ? null : streamed;
    result = { status: "needs_attention", turnId: input.turnId };
  }
  return null;
};

export const runInteractiveAssistant = async (
  ctx: CloudCliContext,
  options: InteractiveOptions,
  reader: LineReader = createLineReader(),
): Promise<number> => {
  let conversationId = options.conversationId;
  let activeConversation: Awaited<ReturnType<typeof resolveConversation>> | undefined;
  let model = options.model;
  let attachments = [...(options.attachments ?? [])];
  const preparedAttachments = new Map<string, Awaited<ReturnType<typeof uploadAttachment>>>();
  let activeAbort: AbortController | null = null;
  let streaming = false;
  let exitRequested = false;
  const bashCwd = process.cwd();
  const removeInterrupt = reader.onInterrupt(() => {
    if (activeAbort && streaming) activeAbort.abort();
    else {
      exitRequested = true;
      activeAbort?.abort();
      reader.close();
    }
  });

  const send = async (message: string): Promise<number> => {
    await validateLocalAttachments(attachments);
    if (!activeConversation)
      activeConversation = await resolveConversation(ctx, { conversationId, title: options.title, projectId: options.projectId });
    const conversation = activeConversation;
    if (!conversationId) {
      conversationId = conversation.id;
      printResumeHint(ctx, conversation.id, true);
    }
    for (const path of attachments) {
      if (!preparedAttachments.has(path)) preparedAttachments.set(path, await uploadAttachment(ctx, conversation.id, path));
    }
    const attachmentContent = attachments.map((path) => preparedAttachments.get(path)!);
    const abort = new AbortController();
    activeAbort = abort;
    try {
      streaming = true;
      const { submitted, result } = await submitAssistantTurn({
        ctx,
        conversationId: conversation.id,
        path: conversationPath(conversation.id, "/turns"),
        body: {
          message,
          ...(attachmentContent.length > 0 ? { content: attachmentContent } : {}),
          ...(model ? { modelProfileId: model } : {}),
          ...(options.allowBash ? { clientToolIds: ["local_bash"] } : {}),
        },
        watch: true,
        signal: abort.signal,
        onToolBlock: (block) => {
          if (block.name === "card" && block.status === "completed") printCard(ctx, block.args);
        },
      }).finally(() => {
        streaming = false;
      });
      attachments = [];
      preparedAttachments.clear();
      if (!result) return 0;
      if (result.status === "aborted") {
        await readApi(ctx, conversationPath(conversation.id, `/turns/${encodeURIComponent(submitted.turn.id)}/abort`), { method: "POST" });
        printInfo(ctx, "Turn stopped.");
        return 0;
      }
      if (result.status === "failed") {
        ctx.error(result.error || "Assistant turn failed.");
        return 0;
      }
      if (result.status === "needs_attention" && result.turnId) {
        const attentionResult = await resolveAttention({
          ctx,
          reader,
          conversationId: conversation.id,
          turnId: result.turnId,
          signal: abort.signal,
          allowBash: options.allowBash === true,
          bashCwd,
          setStreaming: (value) => {
            streaming = value;
          },
        });
        if (!attentionResult) return 2;
        if (attentionResult.status === "aborted") {
          await readApi(ctx, conversationPath(conversation.id, `/turns/${encodeURIComponent(submitted.turn.id)}/abort`), {
            method: "POST",
          });
          printInfo(ctx, "Turn stopped.");
        } else if (attentionResult.status === "failed") {
          ctx.error(attentionResult.error || "Assistant turn failed.");
        }
        return 0;
      }
      return 0;
    } finally {
      activeAbort = null;
    }
  };

  const sendSafely = async (message: string): Promise<number> => {
    try {
      return await send(message);
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") printInfo(ctx, "Turn stopped.");
      else ctx.error(error instanceof Error ? error.message : String(error));
      return 0;
    }
  };

  const resumeActiveTurn = async (): Promise<number> => {
    if (!options.conversationId) return 0;
    const detail = await readConversationDetail(ctx, options.conversationId);
    activeConversation = detail.conversation;
    const turnId = detail.activeTurn?.turnId;
    if (!turnId) return 0;

    const abort = new AbortController();
    activeAbort = abort;
    try {
      streaming = true;
      const result = await streamAssistantTurn({
        ctx,
        conversationId: detail.conversation.id,
        turnId,
        signal: abort.signal,
        onToolBlock: (block) => {
          if (block.name === "card" && block.status === "completed") printCard(ctx, block.args);
        },
      }).finally(() => {
        streaming = false;
      });
      if (result.status === "needs_attention") {
        const resumed = await resolveAttention({
          ctx,
          reader,
          conversationId: detail.conversation.id,
          turnId,
          signal: abort.signal,
          allowBash: options.allowBash === true,
          bashCwd,
          setStreaming: (value) => {
            streaming = value;
          },
        });
        return resumed ? 0 : 2;
      }
      if (result.status === "failed") ctx.error(result.error || "Assistant turn failed.");
      return result.status === "aborted" ? 130 : 0;
    } finally {
      activeAbort = null;
    }
  };

  const handleCommand = async (line: string): Promise<boolean> => {
    if (line === "/help") {
      printInteractiveHelp(ctx);
      return true;
    }
    if (line === "/exit") {
      exitRequested = true;
      return true;
    }
    if (line === "/files") {
      if (!conversationId) ctx.print("No chat files yet.");
      else {
        const files = await readApi<FileList>(ctx, conversationPath(conversationId, "/files"));
        if (files.files.length === 0) ctx.print("No chat files yet.");
        else files.files.forEach((file) => ctx.print(`${file.path}\t${file.size}`));
      }
      return true;
    }
    if (line.startsWith("/attach ")) {
      const path = line.slice(8).trim();
      if (!path || !(await Bun.file(path).exists())) ctx.error(`Attachment not found: ${path || "<path>"}`);
      else if (attachments.length >= AI_TURN_ATTACHMENT_MAX_ITEMS) {
        ctx.error(`At most ${AI_TURN_ATTACHMENT_MAX_ITEMS} attachments can be sent with one message.`);
      } else {
        attachments.push(path);
        printInfo(ctx, `Attached for next message: ${basename(path)}`);
      }
      return true;
    }
    if (line === "/model") {
      const models = await readApi<AiPublicModelProfile[]>(ctx, "/models");
      const selected = await selectNumberedChoice<string | null>({
        output: ctx,
        reader,
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
      return true;
    }
    if (line.startsWith("/model ")) {
      const value = line.slice(7).trim();
      model = value === "default" ? undefined : value || model;
      printInfo(ctx, model ? `Model: ${model}` : "Model: default");
      return true;
    }
    return false;
  };

  try {
    ctx.print(`Assistant · ${await readInitialModelLabel(ctx, model)} · /help for commands`);
    if (options.allowBash) {
      printInfo(
        ctx,
        `Local Bash enabled in ${bashCwd}. Commands run as your current OS user after confirmation; their output is stored in Cloud and sent to the model.`,
      );
    }
    const resumeCode = await resumeActiveTurn();
    if (resumeCode !== 0) return resumeCode;
    if (options.initialPrompt?.trim()) {
      const code = await sendSafely(options.initialPrompt.trim());
      if (code !== 0) return code;
    }
    while (!exitRequested) {
      const line = await reader.read("> ");
      if (line === null) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        if (await handleCommand(trimmed)) continue;
      } catch (error) {
        ctx.error(error instanceof Error ? error.message : String(error));
        continue;
      }
      const code = await sendSafely(trimmed);
      if (code !== 0) return code;
    }
    return 0;
  } finally {
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
    allowBash: flag.boolean({ description: "Offer a locally executed Bash tool with confirmation for every command" }),
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
      });
    }

    if (flags.allowBash) throw new Error("--allow-bash is available only in interactive mode.");

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
