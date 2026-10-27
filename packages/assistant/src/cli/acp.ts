import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentContext,
  type AvailableCommand,
  agent,
  type ContentBlock,
  type CreateElicitationResponse,
  type ElicitationSchema,
  ndJsonStream,
  type PermissionOption,
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
  type ToolCall,
} from "@agentclientprotocol/sdk";
import type {
  AiConversationPage,
  AiDraftContentPart,
  AiLocalContext,
  AiPendingTurnAction,
  AiPeopleModels,
  AiProject,
  AiSkillSummary,
} from "@k2b/cloud/ai";
import { parseAiModelChoice } from "@k2b/cloud/ai";
import {
  AI_IMAGE_INPUT_MAX_BYTES,
  AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS,
  AI_LOCAL_SKILLS_MAX_ITEMS,
  AI_LOCAL_TOOL_NAMES,
  AI_TURN_ATTACHMENT_MAX_ITEMS,
  AI_TURN_IMAGE_MAX_TOTAL_BYTES,
  CloudAiSurveyInputSchema,
  CloudAiTextEditorInputSchema,
  CODE_RUNTIME_TOOL_NAMES,
  guessAiMediaType,
  isAiImageMediaType,
} from "@k2b/cloud/ai/browser";
import { capabilityReviewView } from "@k2b/cloud/capabilities";
import { type CloudCliContext, command } from "@k2b/cloud/cli";
import { APPROVAL_ACP_CLIENT, APPROVAL_CLIENT_HEADER } from "@k2b/cloud/contracts/approvals";
import type { AiChatQuotaSnapshot } from "@k2b/cloud/shared";
import { version } from "../../package.json";
import {
  approvalOptions,
  approvalReviewText,
  boundedRaw,
  localQuestion,
  markdownTable,
  planEntries,
  requiresCloudApproval,
  surveyForm,
  surveyResult,
  type ToolBlock,
  textEditorForm,
  textEditorResult,
  toolCall,
  toolContent,
} from "./acp-updates";
import { readApprovalPreferences, revokeApprovalPreference } from "./approvals";
import { localTurnFields, readSelectedLocalSkill } from "./interactive";
import { createLocalContextReader, discoverLocalContext, type LocalContext, type LocalSkill } from "./local-context";
import { classifyLocalPath, resolveLocalPath } from "./local-paths";
import { createLocalSessionFolder, type LocalQuestionKind, runLocalTool } from "./local-tools";
import { AI_API, jsonRequest, readApi, readProjectsApi } from "./shared";
import { type AssistantTurnStreamResult, createAssistantTurnOutput, streamAssistantTurn } from "./stream";
import { terminalSafeText } from "./terminal";
import { conversationPath, readConversationDetail, resolveConversation, submitAssistantTurn, uploadAttachmentFile } from "./turn";

const builtins: AvailableCommand[] = [
  { name: "web", description: "Open this chat in Cloud" },
  { name: "usage", description: "Show usage shares and reset dates" },
  { name: "approvals", description: "List and revoke remembered Cloud approvals", input: { hint: "number to revoke" } },
  { name: "project", description: "Choose a Project for this chat", input: { hint: "number from the list" } },
  { name: "skills", description: "List local and Cloud Skills" },
];
const diagnostic = (text: string) => {
  process.stderr.write(`${terminalSafeText(text)}\n`);
};
class WebChatRequired extends Error {}
type Session = {
  id: string;
  cwd: string;
  chat?: string;
  model?: string;
  project?: string;
  models: AiPeopleModels["options"][number][];
  localTools: "off" | "ask";
  context?: LocalContext;
  contextReader: () => Promise<LocalContext>;
  folder: ReturnType<typeof createLocalSessionFolder>;
  selectedLocal: LocalSkill[];
  selectedCloud: AiDraftContentPart[];
  cloudSkills: AiSkillSummary[];
  active?: AbortController;
  finished?: Promise<void>;
  disconnected: boolean;
  title?: string;
  commands?: string;
  queue: Promise<void>;
  client: AgentContext;
};

export const createAcpAgent = (host: CloudCliContext) => {
  const sessions = new Map<string, Session>();
  let forms = false;
  let clientName: string | undefined;
  const getSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw RequestError.resourceNotFound(id);
    return s;
  };
  const update = (s: Session, value: SessionUpdate): Promise<void> => {
    s.queue = s.queue.then(() => s.client.notify("session/update", { sessionId: s.id, update: value }));
    // Keep synchronous CLI output callbacks from leaving unhandled rejections on disconnect.
    void s.queue.catch(() => undefined);
    return s.queue;
  };
  const message = (s: Session, text: string) => update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const chatLink = (s: Session) => `${host.options.server.replace(/\/$/, "")}/app/assistant?conversation=${s.chat}`;
  const promptContext = (s: Session): CloudCliContext => ({
    ...host,
    options: { ...host.options, output: "text" },
    openUrl: undefined,
    write: (text) => message(s, text),
    print: (text = "") => {
      void message(s, `${text}\n`);
    },
    table: (rows, columns) => {
      void message(s, markdownTable(rows, columns));
    },
    error: diagnostic,
    json: (value) => diagnostic(JSON.stringify(value)),
    jsonLine: (value) => diagnostic(JSON.stringify(value)),
    fetch: (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set(APPROVAL_CLIENT_HEADER, APPROVAL_ACP_CLIENT);
      return host.fetch(path, { ...init, headers });
    },
  });
  const models = async () => {
    if (!host.options.token)
      throw RequestError.authRequired(undefined, "Sign in first: run `cld login` in a terminal, then start a new thread.");
    const response = await host.fetch(`${AI_API}/models`);
    if (response.status === 401)
      throw RequestError.authRequired(undefined, "Sign in first: run `cld login` in a terminal, then start a new thread.");
    return host.readJson<AiPeopleModels>(response).then((payload) => payload.options);
  };
  const config = (s: Session): SessionConfigOption[] => [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: s.model ?? "default",
      options: [
        { value: "default", name: "Cloud default" },
        ...s.models.map((m) => ({ value: m.id, name: m.label, description: m.description })),
      ],
    },
  ];
  const cancelled = (s: Session): never => {
    s.active?.abort();
    throw new DOMException("Prompt cancelled", "AbortError");
  };
  const permission = async (s: Session, call: ToolCall, options: PermissionOption[]) => {
    await s.queue;
    s.active?.signal.throwIfAborted();
    const result = await s.client.request(
      "session/request_permission",
      { sessionId: s.id, toolCall: call, options },
      { cancellationSignal: s.active?.signal },
    );
    if (result.outcome.outcome === "cancelled") return cancelled(s);
    const optionId = result.outcome.optionId;
    if (!options.some((option) => option.optionId === optionId)) throw RequestError.invalidParams(undefined, "Unknown permission choice.");
    return optionId;
  };
  const form = async (s: Session, callId: string, text: string, schema: ElicitationSchema): Promise<CreateElicitationResponse> => {
    await s.queue;
    s.active?.signal.throwIfAborted();
    return s.client.request(
      "elicitation/create",
      { mode: "form", sessionId: s.id, toolCallId: callId, message: terminalSafeText(text), requestedSchema: schema },
      { cancellationSignal: s.active?.signal },
    );
  };
  const ask = async (s: Session, callId: string, lines: string[], question: string, kind: LocalQuestionKind, synthetic = false) => {
    const presentation = localQuestion(kind);
    const text = [...lines, question].map(terminalSafeText).join("\n");
    const call: ToolCall = {
      toolCallId: callId,
      title: terminalSafeText(question),
      kind: presentation.kind,
      status: "pending",
      content: toolContent(text),
    };
    if (synthetic) await update(s, { sessionUpdate: "tool_call", ...call });
    let allowed = false;
    try {
      if (forms && (kind === "bash" || kind === "replace" || kind === "instructions")) {
        const response = await form(s, callId, text, {
          type: "object",
          required: ["decision"],
          properties: {
            decision: {
              type: "string",
              oneOf: [
                { const: "yes", title: presentation.name },
                { const: "no", title: presentation.reject },
              ],
            },
          },
        });
        if (s.active?.signal.aborted) return cancelled(s);
        allowed =
          response.action === "accept" &&
          response.content != null &&
          typeof response.content === "object" &&
          "decision" in response.content &&
          response.content.decision === "yes";
      } else
        allowed =
          (await permission(s, call, [
            { optionId: "once", name: presentation.name, kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ])) === "once";
      return allowed;
    } finally {
      if (synthetic && !s.disconnected)
        await update(s, { sessionUpdate: "tool_call_update", toolCallId: callId, status: allowed ? "completed" : "failed" });
    }
  };
  const createSession = async (id: string, cwd: string, client: AgentContext, profiles: AiPeopleModels["options"][number][]) => {
    const contextReader = createLocalContextReader({
      ctx: host,
      workspace: cwd,
      askTrust: async (found) => {
        const parts: string[] = [];
        if (found.instructionPaths.length)
          parts.push(`AGENTS.md (${found.instructionPaths.length} ${found.instructionPaths.length === 1 ? "file" : "files"})`);
        const count = found.skills.filter((skill) => skill.scope === "project").length;
        if (count) parts.push(`${count} Skills in .agents/skills`);
        else if (found.hasProjectContext && !parts.length) parts.push("Skills in .agents/skills");
        const toolCallId = crypto.randomUUID();
        const call: ToolCall = {
          toolCallId,
          title: "Load this folder's instructions?",
          kind: "other",
          status: "pending",
          content: toolContent(
            `This folder has instructions for the assistant: ${parts.join(", ")}. They go to the model with every message and can steer what it does with your Cloud data.`,
          ),
        };
        await update(s, { sessionUpdate: "tool_call", ...call });
        let answer: string | undefined;
        try {
          answer = await permission(s, call, [
            { optionId: "session", name: "Only this session", kind: "allow_once" },
            { optionId: "folder", name: "Trust this folder", kind: "allow_always" },
            { optionId: "reject", name: "Don't load", kind: "reject_once" },
          ]);
          return answer === "session" || answer === "folder" ? answer : undefined;
        } finally {
          if (!s.disconnected)
            await update(s, {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: answer === "session" || answer === "folder" ? "completed" : "failed",
            });
        }
      },
    });
    const s: Session = {
      id,
      cwd,
      client,
      models: profiles,
      localTools: (await host.getDefault("assistant.localTools")) === "off" ? "off" : "ask",
      contextReader,
      folder: createLocalSessionFolder(),
      selectedLocal: [],
      selectedCloud: [],
      cloudSkills: [],
      disconnected: false,
      queue: Promise.resolve(),
    };
    sessions.set(id, s);
    return s;
  };
  const commands = async (s: Session, refresh = false) => {
    if (refresh) s.context = await s.contextReader();
    s.context ??= await discoverLocalContext(s.cwd, undefined, false);
    s.cloudSkills = (await readApi<{ skills: AiSkillSummary[] }>(promptContext(s), "/skills")).skills.filter((skill) => skill.enabled);
    const names = new Set(builtins.map((b) => b.name));
    const skills: AvailableCommand[] = [];
    for (const skill of [...s.context.skills, ...s.cloudSkills]) {
      if (names.has(skill.name)) continue;
      names.add(skill.name);
      skills.push({
        name: skill.name,
        description: terminalSafeText(skill.description).replaceAll(/\s+/g, " ").trim().slice(0, 200),
        input: { hint: "message" },
      });
      if (skills.length === AI_LOCAL_SKILLS_MAX_ITEMS) break;
    }
    const availableCommands = [...builtins, ...skills];
    const serialized = JSON.stringify(availableCommands);
    if (serialized !== s.commands) {
      s.commands = serialized;
      await update(s, { sessionUpdate: "available_commands_update", availableCommands });
    }
  };
  const afterResponse = (s: Session, title?: string, notice?: string) => {
    setImmediate(() => {
      void (async () => {
        if (s.disconnected) return;
        await commands(s);
        if (notice !== undefined) await message(s, notice + "\n");
        if (title !== undefined) {
          s.title = title;
          await update(s, { sessionUpdate: "session_info_update", title: terminalSafeText(title) });
        }
      })().catch((e: unknown) => {
        if (!s.disconnected) diagnostic(e instanceof Error ? e.message : String(e));
      });
    });
  };
  const commandReply = async (s: Session, name: string, value: string): Promise<{ handled: boolean; message?: string }> => {
    const ctx = promptContext(s);
    const reply = async (text: string) => {
      await message(s, terminalSafeText(text) + "\n");
      return { handled: true };
    };
    if (name === "web") return reply(s.chat ? `Open this chat in Cloud: ${chatLink(s)}` : "No chat yet. Your first message starts one.");
    if (name === "usage") {
      const quota = await readApi<AiChatQuotaSnapshot>(ctx, "/quotas");
      if (!quota.enabled) return reply("No usage limits apply.");
      const profiles = await readApi<AiPeopleModels>(ctx, "/models").then((payload) => payload.options);
      const label = (id: string) => profiles.find((m) => m.id === id)?.label ?? id;
      const dates = new Intl.DateTimeFormat(ctx.options.locale, { dateStyle: "medium", timeStyle: "short" });
      const lines = quota.balances.map((balance) => {
        const usage = balance.unlimited ? "no limit" : balance.usedPercent === null ? "usage unknown" : `${balance.usedPercent}% used`;
        const reset = !balance.unlimited && balance.resetsAt ? ` · resets ${dates.format(new Date(balance.resetsAt))}` : "";
        return `${balance.scope === "*" ? "All models" : label(balance.scope)}  ${usage}${reset}`;
      });
      if (quota.unlimitedModels?.length) lines.push(`Not counted: ${quota.unlimitedModels.map(label).join(", ")}`);
      return reply(lines.join("\n"));
    }
    if (name === "approvals") {
      const approvals = [
        ...(await readApprovalPreferences(ctx)).approvals,
        ...(s.chat ? (await readApprovalPreferences(ctx, s.chat)).approvals : []),
      ];
      if (!value)
        return reply(
          approvals.length
            ? approvals
                .map(
                  (a, i) =>
                    `${i + 1}. ${a.title} · ${a.website ? "Website" : (a.app?.name ?? "Cloud AI tool")} · ${a.conversationId ? "this chat" : "everywhere"}`,
                )
                .join("\n") + "\nRevoke one with /approvals <number>."
            : "No remembered Cloud approvals.",
        );
      const approval = /^\d+$/.test(value) ? approvals[Number(value) - 1] : undefined;
      if (!approval) throw RequestError.invalidParams(undefined, "Choose an approval number from /approvals.");
      await revokeApprovalPreference(ctx, approval.id);
      return reply(`Revoked: ${approval.title} (${approval.conversationId ? "this chat" : "everywhere"}).`);
    }
    if (name === "project") {
      const { projects } = await readProjectsApi<{ projects: AiProject[] }>(ctx, "/");
      if (!value)
        return reply(
          [
            `0. No Project${!s.project ? " (current)" : ""}`,
            ...projects.map(
              (p, i) =>
                `${i + 1}. ${p.name} — ${p.description.replaceAll(/\s+/g, " ").trim()}${p.shortId === s.project ? " (current)" : ""}`,
            ),
            "Choose with /project <number>.",
          ].join("\n"),
        );
      const project = /^\d+$/.test(value) ? projects[Number(value) - 1] : undefined;
      if (value !== "0" && !project) throw RequestError.invalidParams(undefined, "Choose a Project number from /project.");
      s.project = project?.shortId;
      if (s.chat) await readApi(ctx, conversationPath(s.chat, "/project"), jsonRequest("PUT", { projectId: s.project ?? null }));
      return reply(`Project: ${project?.name ?? "none"}${!s.chat ? " Your first message starts the chat there." : ""}`);
    }
    if (name === "skills") {
      await commands(s, true);
      const local = s.context?.skills ?? [];
      const visible = s.cloudSkills.filter((skill) => !local.some((l) => l.name === skill.name));
      const preview = (text: string) => {
        const line = text.replaceAll(/\s+/g, " ").trim();
        return line.length > 72 ? `${line.slice(0, 71)}…` : line;
      };
      const lines = [
        ...local.map(
          (skill) =>
            `- ${skill.name} · ${skill.scope} · ${preview(skill.description)}${skill.manualOnly ? ` (only with /${skill.name})` : ""}`,
        ),
        ...visible.map(
          (skill) => `- ${skill.name} · Cloud · ${preview(skill.description)}${skill.manualOnly ? ` (only with /${skill.name})` : ""}`,
        ),
      ];
      const hidden = [
        ...(s.context?.hidden ?? []),
        ...s.cloudSkills
          .filter((skill) => local.some((l) => l.name === skill.name))
          .map((skill) => ({
            name: skill.name,
            scope: "Cloud",
            reason: `hidden by the ${local.find((l) => l.name === skill.name)?.scope} Skill`,
          })),
      ];
      if (hidden.length) lines.push("Hidden", ...hidden.map((skill) => `- ${skill.name} · ${skill.scope} · ${skill.reason}`));
      if (s.context?.problems.length) lines.push("Problems", ...s.context.problems.map((p) => `- ${p.path} · ${p.error}`));
      return reply(
        lines.length
          ? "Skills · /<name> selects one for your next message\n" + lines.join("\n")
          : "No Skills found. Local Skills live in .agents/skills or ~/.agents/skills.",
      );
    }
    await commands(s);
    let local = s.context?.skills.find((skill) => skill.name === name);
    const cloud = s.cloudSkills.find((skill) => skill.name === name);
    if (!local && !cloud) return { handled: false };
    if (local) {
      if (s.localTools === "off") return reply("Local tools are off for this profile.");
      s.context = await s.contextReader();
      local = s.context.skills.find((skill) => skill.name === name);
      if (!local) return reply(`Skill ${name} is not loaded.`);
      if (!s.selectedLocal.some((skill) => skill.name === name)) {
        if (s.selectedLocal.length >= AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS)
          throw RequestError.invalidParams(undefined, `At most ${AI_LOCAL_SELECTED_SKILLS_MAX_ITEMS} local Skills can be selected.`);
        s.selectedLocal.push(local);
      }
    } else if (cloud && !s.selectedCloud.some((part) => part.type === "resource" && part.ref.id === cloud.shortId)) {
      s.selectedCloud.push({ type: "resource", ref: { type: "core.ai.skill", id: cloud.shortId }, title: cloud.name });
    }
    return value ? { handled: true, message: value } : reply(`Skill ${name} is selected for your next message.`);
  };
  const prompt = async (s: Session, content: ContentBlock[]) => {
    if (s.active) throw RequestError.invalidRequest(undefined, "This session already has a running prompt.");
    const abort = new AbortController();
    s.active = abort;
    let finishPrompt: () => void = () => {};
    s.finished = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    const ctx = promptContext(s);
    let turnId: string | undefined;
    let output = createAssistantTurnOutput();
    const waitingApprovals = new Set<string>();
    const calls = new Map<string, string>();
    const rows = new Map<string, string>();
    const onToolBlock = (block: ToolBlock) => {
      rows.set(block.callId, block.id);
      const call = toolCall(block, s.cwd);
      const serialized = JSON.stringify(block);
      if (calls.get(block.id) !== serialized) {
        void update(s, calls.has(block.id) ? { sessionUpdate: "tool_call_update", ...call } : { sessionUpdate: "tool_call", ...call });
        calls.set(block.id, serialized);
        if (block.name === "todo_write") {
          const entries = planEntries(block.args);
          if (entries) void update(s, { sessionUpdate: "plan", entries });
        }
      }
      if (block.status !== "awaiting_approval")
        for (const callId of waitingApprovals) if (rows.get(callId) === block.id) waitingApprovals.delete(callId);
      if (block.status === "awaiting_client" && CODE_RUNTIME_TOOL_NAMES.some((name) => name === block.name)) throw new WebChatRequired();
    };
    const clientTools = {
      names: new Set(["local_bash", ...AI_LOCAL_TOOL_NAMES]),
      run: async (call: { name: string; args: unknown; callId: string }, signal: AbortSignal) => {
        s.context ??= await s.contextReader();
        return runLocalTool(
          call,
          {
            ctx,
            workspace: s.cwd,
            conversationId: s.chat!,
            mode: s.localTools,
            skills: s.context?.skills ?? [],
            freeReadRoots: s.context?.skills.map((skill) => skill.directory) ?? [],
            sessionFolder: s.folder,
            ask: (lines, question, kind) => ask(s, rows.get(call.callId) ?? call.callId, lines, question, kind),
            printBash: () => {},
          },
          signal,
        );
      },
    };
    const streamOptions = () => ({
      ctx,
      conversationId: s.chat!,
      turnId,
      output,
      signal: abort.signal,
      clientTools,
      waitingApprovals,
      onToolBlock,
      onThinkingDelta: (text: string) => {
        void update(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
      },
    });
    const waitInCloud = async (action: Extract<AiPendingTurnAction, { type: "approval_request" }>) => {
      if (waitingApprovals.has(action.callId)) return;
      waitingApprovals.add(action.callId);
      const text = `Waiting for your confirmation in Cloud or Cloud Login: ${chatLink(s)}`;
      await update(s, {
        sessionUpdate: "tool_call_update",
        toolCallId: rows.get(action.callId) ?? action.callId,
        content: toolContent(text),
      });
      await message(s, text + "\n");
    };
    const attention = async (result: AssistantTurnStreamResult): Promise<AssistantTurnStreamResult> => {
      while (result.status === "needs_attention") {
        abort.signal.throwIfAborted();
        const actions = await readApi<AiPendingTurnAction[]>(
          ctx,
          conversationPath(s.chat!, `/pending-actions/${encodeURIComponent(turnId!)}`),
        );
        const action = actions.find((a) => !(a.type === "approval_request" && waitingApprovals.has(a.callId)));
        if (!action) {
          result = await streamAssistantTurn(streamOptions());
          continue;
        }
        let body: unknown;
        if (action.type === "approval_request") {
          const choice = await permission(
            s,
            {
              toolCallId: rows.get(action.callId) ?? action.callId,
              title: terminalSafeText(
                (action.review
                  ? capabilityReviewView(action.review, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).message
                  : undefined) ??
                  action.message ??
                  action.name,
              ),
              kind: action.website ? "fetch" : "other",
              status: "pending",
              content: toolContent(approvalReviewText(action, chatLink(s))),
              ...(boundedRaw(action.args) !== undefined ? { rawInput: action.args } : {}),
            },
            approvalOptions(action),
          );
          if (choice === "cloud" || (requiresCloudApproval(action) && choice !== "reject")) {
            await waitInCloud(action);
            result = await streamAssistantTurn(streamOptions());
            continue;
          }
          if (choice !== "once" && choice !== "chat" && choice !== "reject")
            throw RequestError.invalidParams(undefined, "Unknown approval choice.");
          body = { type: "approval_response", approved: choice !== "reject", ...(choice === "chat" ? { remember: "chat" } : {}) };
        } else if (action.name === "survey" || action.name === "cloud_survey") {
          const input = CloudAiSurveyInputSchema.parse(action.args);
          const response = forms
            ? await form(s, action.callId, [input.title, input.description].filter(Boolean).join("\n"), surveyForm(input))
            : undefined;
          abort.signal.throwIfAborted();
          body = { type: "tool_result", result: surveyResult(input, response) };
        } else if (action.name === "text_editor" || action.name === "cloud_text_editor") {
          const input = CloudAiTextEditorInputSchema.parse(action.args);
          const response = forms
            ? await form(s, action.callId, [input.title, input.description].filter(Boolean).join("\n"), textEditorForm(input))
            : undefined;
          abort.signal.throwIfAborted();
          body = { type: "tool_result", result: textEditorResult(input, response) };
        } else throw new WebChatRequired();
        abort.signal.throwIfAborted();
        const response = await ctx.fetch(
          `${AI_API}${conversationPath(s.chat!, `/turns/${encodeURIComponent(turnId!)}/actions/${encodeURIComponent(action.callId)}`)}`,
          jsonRequest("POST", body),
        );
        if (response.status === 403 && action.type === "approval_request") await waitInCloud(action);
        else await ctx.readJson(response);
        result = await streamAssistantTurn(streamOptions());
      }
      return result;
    };
    const finish = async (result: AssistantTurnStreamResult) => {
      if (result.status === "failed") throw RequestError.internalError(undefined, result.error ?? "Assistant turn failed.");
      if (result.status === "aborted") return cancelled(s);
    };
    try {
      let text = content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const files: File[] = [];
      let imageCount = 0;
      for (const part of content) {
        abort.signal.throwIfAborted();
        if (part.type === "resource_link") {
          if (!part.uri.startsWith("file://")) {
            text += `\n${part.uri}`;
            continue;
          }
          const path = fileURLToPath(part.uri);
          const access = classifyLocalPath(path, { workspace: s.cwd });
          if (access.access === "blocked")
            throw RequestError.invalidParams(undefined, `Not attached: ${terminalSafeText(path)} is cld's configuration.`);
          if (access.access === "ask") {
            const reason =
              access.reason === "home"
                ? "You started cld in your home folder or above, so every file asks first."
                : access.reason === "protected"
                  ? "It may contain secrets."
                  : `It is outside ${s.cwd}.`;
            if (!(await ask(s, crypto.randomUUID(), [], `Attach ${path}? ${reason}`, "access", true))) continue;
          }
          const file = Bun.file(resolveLocalPath(path, s.cwd));
          if (!(await file.exists())) throw RequestError.invalidParams(undefined, `Attachment not found: ${terminalSafeText(path)}`);
          files.push(new File([file], basename(path), { type: file.type || guessAiMediaType(path) }));
        } else if (part.type === "image") {
          const extension = part.mimeType === "image/jpeg" ? "jpg" : part.mimeType.split("/")[1]?.replaceAll(/[^a-z0-9]/gi, "") || "bin";
          files.push(new File([Buffer.from(part.data, "base64")], `image-${++imageCount}.${extension}`, { type: part.mimeType }));
        } else if (part.type === "resource") {
          const resource = part.resource;
          files.push(
            new File(
              ["text" in resource ? resource.text : Buffer.from(resource.blob, "base64")],
              basename(new URL(resource.uri).pathname) || "resource",
              { type: resource.mimeType ?? ("text" in resource ? "text/plain" : "application/octet-stream") },
            ),
          );
        }
      }
      if (files.length > AI_TURN_ATTACHMENT_MAX_ITEMS)
        throw RequestError.invalidParams(undefined, `At most ${AI_TURN_ATTACHMENT_MAX_ITEMS} attachments can be sent with one message.`);
      let imageBytes = 0;
      for (const file of files)
        if (isAiImageMediaType(file.type)) {
          if (file.size > AI_IMAGE_INPUT_MAX_BYTES)
            throw RequestError.invalidParams(
              undefined,
              `Image attachment exceeds the ${AI_IMAGE_INPUT_MAX_BYTES / (1024 * 1024)} MB limit: ${file.name}`,
            );
          imageBytes += file.size;
        }
      if (imageBytes > AI_TURN_IMAGE_MAX_TOTAL_BYTES)
        throw RequestError.invalidParams(
          undefined,
          `Image attachments exceed the ${AI_TURN_IMAGE_MAX_TOTAL_BYTES / (1024 * 1024)} MB total limit.`,
        );
      const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (match) {
        const command = await commandReply(s, match[1]!, match[2]?.trim() ?? "");
        if (command.handled && command.message === undefined) return { stopReason: "end_turn" as const };
        if (command.message !== undefined) text = command.message;
      }
      if (!s.chat) {
        s.chat = (await resolveConversation(ctx, { projectId: s.project })).id;
        await host.setDefault(`assistant.acpSession.${s.id}`, s.chat);
        await host.setDefault(`assistant.acpChat.${s.chat}`, s.id);
      }
      const detail = await readConversationDetail(ctx, s.chat);
      if (detail.activeTurn) {
        turnId = detail.activeTurn.turnId;
        await finish(await attention(await streamAssistantTurn(streamOptions())));
        turnId = undefined;
        output = createAssistantTurnOutput();
        calls.clear();
        rows.clear();
        waitingApprovals.clear();
      }
      s.context = await s.contextReader();
      await commands(s);
      const selectedSkills: AiLocalContext["selectedSkills"] = [];
      if (s.localTools === "ask")
        for (const selected of s.selectedLocal) {
          const skill = s.context.skills.find((skill) => skill.name === selected.name && skill.directory === selected.directory);
          if (!skill) continue;
          const loaded = await readSelectedLocalSkill({
            skill,
            context: s.context,
            workspace: s.cwd,
            ask: (question) => ask(s, crypto.randomUUID(), [], question, "access", true),
          });
          if (loaded) selectedSkills.push(loaded);
        }
      const attachments = [];
      for (const file of files) attachments.push(await uploadAttachmentFile(ctx, s.chat, file, undefined, abort.signal));
      abort.signal.throwIfAborted();
      const fields = localTurnFields({
        context: s.context,
        localTools: s.localTools,
        workspace: s.cwd,
        client: { kind: "acp", ...(clientName ? { name: clientName } : {}) },
      });
      const submission = await submitAssistantTurn({
        ...streamOptions(),
        path: conversationPath(s.chat, "/turns"),
        watch: true,
        codeHost: false,
        body: {
          message: text,
          content: [...attachments, ...s.selectedCloud],
          ...(s.model ? { model: parseAiModelChoice(s.model) } : {}),
          ...fields,
          localContext: { ...fields.localContext, selectedSkills },
        },
        onSubmitted: (submitted) => {
          turnId = submitted.turn.id;
          s.selectedLocal = [];
          s.selectedCloud = [];
        },
      });
      if (!submission.result) throw RequestError.internalError(undefined, "Missing turn stream result.");
      await finish(await attention(submission.result));
      return { stopReason: "end_turn" as const };
    } catch (error) {
      if (abort.signal.aborted) {
        if (!s.disconnected && turnId && s.chat)
          await readApi(ctx, conversationPath(s.chat, `/turns/${encodeURIComponent(turnId)}/abort`), { method: "POST" });
        return { stopReason: "cancelled" as const };
      }
      if (error instanceof WebChatRequired) {
        await message(s, `This step needs the web chat: ${chatLink(s)}\n`);
        return { stopReason: "end_turn" as const };
      }
      if (error instanceof RequestError) throw error;
      throw RequestError.internalError(undefined, error instanceof Error ? error.message : String(error));
    } finally {
      try {
        if (s.chat && !s.disconnected) {
          const detail = await readConversationDetail(ctx, s.chat);
          if (detail.conversation.title !== s.title) {
            s.title = detail.conversation.title;
            await update(s, { sessionUpdate: "session_info_update", title: terminalSafeText(s.title) });
          }
        }
        await s.queue;
      } finally {
        s.active = undefined;
        finishPrompt();
      }
    }
  };
  let cleanup: Promise<void> | undefined;
  const close = () =>
    (cleanup ??= (async () => {
      for (const s of sessions.values()) {
        s.disconnected = true;
        s.active?.abort();
      }
      await Promise.all(
        [...sessions.values()].map(async (s) => {
          await s.finished;
          await s.folder.close();
        }),
      );
    })());
  const app = agent()
    .onConnect(({ signal }) => {
      signal.addEventListener(
        "abort",
        () => {
          void close().catch((error: unknown) => diagnostic(error instanceof Error ? error.message : String(error)));
        },
        { once: true },
      );
    })
    .onRequest("initialize", ({ params }) => {
      forms = !!params.clientCapabilities?.elicitation?.form;
      clientName = params.clientInfo?.name;
      return {
        protocolVersion: 1,
        agentInfo: { name: "cld", title: "Cloud Assistant", version },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [],
      };
    })
    .onRequest("session/new", async ({ params, client }) => {
      const profiles = await models();
      if (params.mcpServers.length) diagnostic("cld acp ignores MCP servers from the editor; Assistant uses Cloud's own tools.");
      const s = await createSession(crypto.randomUUID(), params.cwd, client, profiles);
      afterResponse(s);
      return { sessionId: s.id, configOptions: config(s) };
    })
    .onRequest("session/set_config_option", ({ params }) => {
      const s = getSession(params.sessionId);
      if (
        typeof params.value !== "string" ||
        params.configId !== "model" ||
        (params.value !== "default" && !s.models.some((m) => m.id === params.value))
      )
        throw RequestError.invalidParams(undefined, "Unknown model option.");
      s.model = params.value === "default" ? undefined : params.value;
      return { configOptions: config(s) };
    })
    .onRequest("session/list", async ({ params }) => {
      const page = params.cursor == null ? 1 : Number(params.cursor);
      if (params.cursor != null && (!/^[1-9]\d*$/.test(params.cursor) || !Number.isSafeInteger(page)))
        throw RequestError.invalidParams(undefined, "Unknown session list cursor.");
      const conversations = await readApi<AiConversationPage>(host, `/conversations/page?page=${page}&perPage=50`);
      return {
        sessions: await Promise.all(
          conversations.items.map(async (chat) => ({
            sessionId: (await host.getDefault(`assistant.acpChat.${chat.id}`)) ?? chat.id,
            cwd: params.cwd ?? process.cwd(),
            title: terminalSafeText(chat.title),
            updatedAt: chat.updatedAt,
          })),
        ),
        ...(conversations.hasNext ? { nextCursor: String(page + 1) } : {}),
      };
    })
    .onRequest("session/resume", async ({ params, client }) => {
      const profiles = await models();
      const chat = (await host.getDefault(`assistant.acpSession.${params.sessionId}`)) ?? params.sessionId;
      const response = await host.fetch(`${AI_API}${conversationPath(chat)}`);
      if (response.status === 404) throw RequestError.resourceNotFound(params.sessionId);
      const detail = await host.readJson<Awaited<ReturnType<typeof readConversationDetail>>>(response);
      const existing = sessions.get(params.sessionId);
      if (existing?.active) throw RequestError.invalidRequest(undefined, "This session already has a running prompt.");
      if (existing) await existing.folder.close();
      const s = await createSession(params.sessionId, params.cwd, client, profiles);
      s.chat = detail.conversation.id;
      s.project = detail.conversation.projectId ?? undefined;
      afterResponse(
        s,
        detail.conversation.title,
        detail.activeTurn
          ? `A turn in this chat is still running. Send a message to follow it here, or open it in Cloud: ${chatLink(s)}`
          : undefined,
      );
      return { configOptions: config(s) };
    })
    .onRequest("session/prompt", ({ params }) => prompt(getSession(params.sessionId), params.prompt))
    .onNotification("session/cancel", ({ params }) => {
      getSession(params.sessionId).active?.abort();
    });
  return { app, close };
};

export const runAcpConnection = async (
  ctx: CloudCliContext,
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
): Promise<void> => {
  const bridge = createAcpAgent(ctx);
  const connection = bridge.app.connect(ndJsonStream(output, input));
  await connection.closed;
  await bridge.close();
};
export const assistantAcpCommand = command("acp", {
  summary: "Run Assistant as an ACP agent for editors such as T3 Code and Zed",
  examples: ["cld acp", "cld assistant acp"],
  async run({ ctx }) {
    if (process.stdin.isTTY)
      throw new Error("cld acp talks to an editor over stdin and stdout. Add `cld acp` to your editor as an ACP agent.");
    await runAcpConnection(
      ctx,
      new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const chunk of process.stdin) controller.enqueue(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      }),
      new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => process.stdout.write(chunk, (error) => (error ? reject(error) : resolve())));
        },
      }),
    );
  },
});
