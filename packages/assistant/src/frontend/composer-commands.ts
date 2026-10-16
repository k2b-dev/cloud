import type { AiChatTaskView, AiProject, AiSkillSummary } from "@k2b/cloud/ai";
import { type AiComposerAttachment, aiChatAttachments } from "@k2b/cloud/ai/ui";
import {
  type ChatCommand,
  type ChatCommandResult,
  type ChatCommandScope,
  type ChatCommandSection,
  type ChatModelOption,
  matchesChatCommand,
} from "@k2b/ui";
import { AssistantTaskRunError, assistantApi } from "../api/client";
import { artifactClient } from "../artifacts/client";
import { assistantTaskTitle, formatAssistantTaskScheduleInline } from "./scheduled-task-format";
import { type AssistantCopy, assistantCopyFor } from "./ui-copy";

export const assistantCommandSections = (copy: AssistantCopy): ChatCommandSection[] => [
  { id: "skills", label: copy.commandSkills, searched: true },
  { id: "files", label: copy.commandFiles, searched: true, searchOnly: true },
  { id: "apps", label: copy.commandApps, searched: true },
  { id: "chat", label: copy.commandChat },
  { id: "tasks", label: copy.commandTasks, searched: true },
];

export const assistantCommandScopes = (copy: AssistantCopy, locale: string): ChatCommandScope[] => [
  { id: "skill", title: copy.commandSkills, words: ["skill", "skills"] },
  {
    id: "file",
    title: copy.commandFiles,
    words: locale.startsWith("de") ? ["datei", "dateien", "file", "files"] : ["file", "files", "datei", "dateien"],
  },
  {
    id: "project",
    title: copy.commandProjects,
    words: locale.startsWith("de") ? ["projekt", "projekte", "project", "projects"] : ["project", "projects", "projekt", "projekte"],
  },
  { id: "app", title: copy.commandApps, words: ["app", "apps", "studio"] },
  {
    id: "model",
    title: copy.commandModels,
    words: locale.startsWith("de") ? ["modell", "modelle", "model", "models"] : ["model", "models", "modell", "modelle"],
  },
  { id: "task", title: copy.commandTasks, words: ["routine", "routinen"] },
];

export function assistantBuiltInCommands(input: {
  copy: AssistantCopy;
  projectComposer: boolean;
  projectName?: string | null;
  running: boolean;
  recording: boolean;
  hasMessages: boolean;
  hasAssistantMessage: boolean;
  models: readonly ChatModelOption[];
  selectedModelId?: string | null;
  searchChat: () => void;
  compact: () => Promise<ChatCommandResult>;
  fork: () => Promise<ChatCommandResult>;
  newChat: () => Promise<ChatCommandResult>;
}): ChatCommand[] {
  const t = input.copy;
  const currentModel = input.models.find((model) => model.id === input.selectedModelId);
  return [
    {
      id: "model",
      name: "model",
      section: "chat",
      label: t.commandModelLabel,
      description: currentModel ? t.commandModelNow({ name: currentModel.label }) : "",
      icon: "ti ti-cpu",
      keywords: ["model", "modell", "ki", "ai", "llm"],
      scope: "model",
      hiddenUntilSearch: input.models.length === 0,
      reason: input.running ? t.commandNeedsIdle : input.models.length === 0 ? t.commandNoModel : undefined,
      // A recording replaces the composer's model control; Enter then narrows to the model list instead.
      action: input.recording
        ? undefined
        : async (ctx) => {
            const id = await ctx.openModelSelection();
            return id ? { done: t.commandModelChosen({ name: input.models.find((model) => model.id === id)?.label ?? id }) } : "cancelled";
          },
    },
    {
      id: "project",
      name: "project",
      label: t.assignProjectLabel,
      description: t.assignProjectHint,
      icon: "ti ti-folders",
      keywords: ["project", "projekt", "zuordnen", "assign"],
      scope: "project",
      section: "chat",
      hiddenUntilSearch: input.projectName != null,
      reason:
        input.projectName != null ? t.commandAlreadyProject({ name: input.projectName }) : input.running ? t.commandNeedsIdle : undefined,
    },
    {
      id: "compact",
      section: "chat",
      hiddenUntilSearch: !input.running && (input.projectComposer || !input.hasMessages),
      name: "compact",
      icon: "ti ti-fold",
      label: t.compactLabel,
      keywords: ["compact", "kompaktieren", "kontext", "zusammenfassen", "platz"],
      description: t.compactDescription,
      busyLabel: t.compactBusy,
      reason: input.running
        ? t.commandNeedsIdle
        : input.projectComposer
          ? t.commandNeedsChat
          : !input.hasMessages
            ? t.commandNeedsMessages
            : undefined,
      action: input.compact,
    },
    {
      id: "fork",
      section: "chat",
      hiddenUntilSearch: !input.running && (input.projectComposer || !input.hasAssistantMessage),
      name: "fork",
      icon: "ti ti-git-fork",
      label: t.forkLabel,
      keywords: ["fork", "abzweigen", "kopie", "verzweigen", "branch"],
      description: t.forkDescription,
      busyLabel: t.forkBusy,
      reason: input.running
        ? t.commandNeedsIdle
        : input.projectComposer
          ? t.commandNeedsChat
          : !input.hasAssistantMessage
            ? t.commandNeedsAnswer
            : undefined,
      action: input.fork,
    },
    {
      id: "search",
      name: "search",
      section: "chat",
      label: t.commandSearchChatLabel,
      description: t.commandSearchChatHint,
      icon: "ti ti-search",
      keywords: ["search", "suchen", "finden", "find", "durchsuchen"],
      hiddenUntilSearch: input.projectComposer || !input.hasMessages,
      reason: input.projectComposer ? t.commandNeedsChat : !input.hasMessages ? t.commandChatEmpty : undefined,
      action: input.searchChat,
    },
    {
      id: "new",
      section: "chat",
      name: "new",
      icon: "ti ti-plus",
      label: t.newChatLabel,
      keywords: ["new", "neu", "chat", "leer"],
      description: t.newChatDescription,
      action: input.newChat,
    },
  ];
}

/** Slice 7 replaces this overview selection with personal use counts. */
export const OVERVIEW_SKILL_COUNT = 4;
export const overviewSkills = (skills: readonly AiSkillSummary[]) => skills.filter((skill) => skill.enabled).slice(0, OVERVIEW_SKILL_COUNT);

/** Keeps pending task starts across composer remounts within one workspace. */
export function createAssistantTaskRunKeys() {
  const pendingRunKeys = new Map<string, { key: string; uncertain: boolean }>();
  return {
    runKey(taskId: string) {
      let pending = pendingRunKeys.get(taskId);
      if (!pending) {
        pending = { key: crypto.randomUUID().replaceAll("-", ""), uncertain: false };
        pendingRunKeys.set(taskId, pending);
      }
      return pending.key;
    },
    runUncertain(taskId: string) {
      const pending = pendingRunKeys.get(taskId);
      if (pending) pending.uncertain = true;
    },
    isUncertain(taskId: string) {
      return pendingRunKeys.get(taskId)?.uncertain === true;
    },
    settleRun(taskId: string, { force = false }: { force?: boolean } = {}) {
      if (force || !pendingRunKeys.get(taskId)?.uncertain) pendingRunKeys.delete(taskId);
    },
  };
}

/** Owns discovery per opening for one composer. */
export function createAssistantCommandSession() {
  let latest:
    | {
        session: number;
        abort: AbortController;
        data: Promise<{ skills: AiSkillSummary[] | null; scheduledTaskSkills: AiSkillSummary[] | null; tasks: AiChatTaskView[] | null }>;
      }
    | undefined;
  return {
    load(session: number) {
      if (latest?.session === session) return latest.data;
      latest?.abort.abort();
      const abort = new AbortController();
      // A failed load is `null`: each section offers its own retry row.
      const skills = assistantApi.listSkills(abort.signal).catch(() => null);
      const scheduledTaskSkills = assistantApi.findSkillsByName("scheduled-tasks", abort.signal).catch(() => null);
      const tasks = Promise.all(
        (["active", "paused", "needs_attention"] as const).map((state) =>
          assistantApi.listChatTasks({ state, limit: 100, signal: abort.signal }),
        ),
      ).then(
        (pages) => pages.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        () => null,
      );
      const data = Promise.all([skills, scheduledTaskSkills, tasks]).then(([skills, scheduledTaskSkills, tasks]) => ({
        skills,
        scheduledTaskSkills,
        tasks,
      }));
      latest = { session, abort, data };
      return data;
    },
    dispose() {
      latest?.abort.abort();
    },
  };
}

const taskKeywords = [
  "routine",
  "routinen",
  "regelmäßig",
  "zeitplan",
  "erinnern",
  "erinnerung",
  "schedule",
  "reminder",
  "geplant",
  "scheduled",
];

/** Only explicit selection inserts a reference or performs an action. */
export async function assistantComposerCommands(input: {
  query: string;
  session: number;
  sessionLoader: ReturnType<typeof createAssistantCommandSession>;
  runKeys: ReturnType<typeof createAssistantTaskRunKeys>;
  models: readonly ChatModelOption[];
  selectedModelId?: string | null;
  chooseModel: (id: string) => void;
  isRunning: () => boolean;
  scope?: string;
  signal: AbortSignal;
  locale: string;
  conversationId?: string;
  projectId?: string | null;
  projects: readonly AiProject[];
  assignProject: (projectId: string) => Promise<void>;
  running: boolean;
}): Promise<ChatCommand[]> {
  const copy = assistantCopyFor(input.locale);
  const legacyScope = !input.scope
    ? assistantCommandScopes(copy, input.locale).find((scope) => scope.words.includes(input.query.trim().toLowerCase()))
    : undefined;
  const category = input.scope ?? legacyScope?.id;
  const query = (legacyScope ? "" : input.query).trim().toLowerCase();
  const includes = (text: string) => text.toLowerCase().includes(query);
  const wants = (kind: string) => !category || category === kind;
  if (category === "model")
    return input.models
      .map(
        (model): ChatCommand => ({
          id: `model:${model.id}`,
          name: model.label,
          label: model.label,
          description: model.description ?? "",
          icon: model.icon ?? "ti ti-cpu",
          selected: model.id === input.selectedModelId,
          reason: input.running ? copy.commandNeedsIdle : undefined,
          action: () => {
            if (input.isRunning()) throw new Error(copy.commandNeedsIdle);
            input.chooseModel(model.id);
            return { done: copy.commandModelChosen({ name: model.label }) };
          },
        }),
      )
      .filter((row) => matchesChatCommand(row, query));

  // The attachment id is the row key: two files named "report.md" in different folders stay two rows.
  const reference = (section: string, name: string, description: string, attachment: AiComposerAttachment): ChatCommand => ({
    section,
    id: attachment.id,
    name,
    label: name,
    description,
    icon: attachment.kind === "image" ? "ti ti-photo" : attachment.icon,
    mention: aiChatAttachments([attachment])[0]!,
  });
  const overview = !category && !query;
  const fullSkillScope = category === "skill" && !query;
  const [sessionData, searchedSkills, apps, chatFiles, project] = await Promise.all([
    wants("task") || fullSkillScope ? input.sessionLoader.load(input.session) : null,
    wants("skill") && !overview && !fullSkillScope ? assistantApi.listSkills(input.signal, query.slice(0, 200)) : [],
    wants("app") ? artifactClient.list(1, query.slice(0, 120), input.signal, input.conversationId) : null,
    (category === "file" || (!category && query.length > 0)) && input.conversationId
      ? assistantApi.listChatFiles(input.conversationId, input.signal)
      : [],
    (category === "file" || (!category && query.length > 0)) && input.projectId
      ? assistantApi.loadProjectContext(input.projectId, input.signal)
      : null,
  ]);
  const allSkills = sessionData?.skills;
  const results: ChatCommand[] = [];
  if ((overview || fullSkillScope) && allSkills === null)
    results.push({
      id: "skills-retry",
      name: "skills-retry",
      section: "skills",
      label: copy.commandSkillsFailed,
      description: copy.commandTryAgain,
      icon: "ti ti-alert-circle",
      searchAgain: true,
    });
  for (const skill of overview ? overviewSkills(allSkills ?? []) : fullSkillScope ? (allSkills ?? []) : searchedSkills) {
    if (!skill.enabled) continue;
    results.push(
      reference("skills", skill.name, `Skill · ${skill.description}`, {
        kind: "resource",
        id: `skill:${skill.id}`,
        name: skill.name,
        ref: { type: "core.ai.skill", id: skill.shortId },
        icon: "ti ti-sparkles",
      }),
    );
  }
  const enabledCount = (allSkills ?? []).filter((skill) => skill.enabled).length;
  if (overview && enabledCount > OVERVIEW_SKILL_COUNT)
    results.push({
      id: "skills-all",
      name: "skills-all",
      section: "skills",
      label: copy.commandAllSkills({ count: enabledCount }),
      description: copy.commandAllSkillsHint,
      icon: "ti ti-list",
      scope: "skill",
    });
  for (const app of apps?.items ?? []) {
    if (app.kind !== "app") continue;
    results.push(
      reference("apps", app.title, `App · ${app.description ?? ""}`, {
        kind: "resource",
        id: `app:${app.id}`,
        name: app.title,
        ref: { type: "assistant.artifact", id: app.id },
        icon: app.icon || "ti ti-app-window",
        href: `/app/assistant/apps/${app.id}`,
      }),
    );
  }
  for (const file of chatFiles) {
    if (!includes(file.path)) continue;
    results.push(
      reference("files", file.path.split("/").at(-1) || file.path, `${copy.chatFileDescription} · ${file.path}`, {
        kind: "stored-file",
        id: `file:${file.path}:${file.version}`,
        name: file.path.split("/").at(-1) || file.path,
        path: file.path,
        version: file.version,
        size: file.size,
        mediaType: file.mediaType,
        icon: "ti ti-file",
      }),
    );
  }
  for (const file of project?.files ?? []) {
    if (!includes(file.path)) continue;
    const path = `/project/${file.path.replace(/^\/+/, "")}`;
    results.push(
      reference("files", path, copy.projectFileDescription, { kind: "project-file", id: path, path, name: path, icon: "ti ti-file" }),
    );
  }
  const assignedProject = input.projectId ? input.projects.find((project) => project.id === input.projectId) : undefined;
  if (category === "project")
    for (const project of input.projects) {
      if (!includes(`${project.name} ${project.description}`)) continue;
      results.push({
        id: `project:${project.id}`,
        name: project.name,
        label: project.name,
        icon: project.icon || "ti ti-folders",
        reason: input.projectId
          ? copy.commandChatAlreadyProject({
              name: assignedProject?.name,
            })
          : input.running
            ? copy.commandNeedsIdle
            : undefined,
        description: copy.assignProjectDescription,
        action: () => input.assignProject(project.id),
      });
    }

  const taskRows: ChatCommand[] = [];
  if (sessionData && wants("task")) {
    // Task discovery and its Skill lookup fail independently of the overview’s full Skill list.
    if (sessionData.tasks === null || sessionData.scheduledTaskSkills === null) {
      taskRows.push({
        id: "tasks-retry",
        name: "tasks-retry",
        section: "tasks",
        label: copy.commandTasksFailed,
        description: copy.commandTryAgain,
        icon: "ti ti-alert-circle",
        searchAgain: true,
      });
    } else {
      const skill = sessionData.scheduledTaskSkills.find((skill) => skill.source?.appId === "assistant");
      taskRows.push({
        ...(skill?.enabled
          ? reference("tasks", skill.name, "", {
              kind: "resource",
              id: `skill:${skill.id}`,
              name: skill.name,
              ref: { type: "core.ai.skill", id: skill.shortId },
              icon: "ti ti-sparkles",
            })
          : {}),
        id: "task-new",
        name: "task-new",
        section: "tasks",
        label: copy.commandNewTaskLabel,
        description: copy.commandNewTaskHint,
        icon: "ti ti-calendar-plus",
        keywords: [...taskKeywords, "neu", "new"],
        reason: !skill ? copy.commandNewTaskSkillUnavailable : !skill.enabled ? copy.commandNewTaskSkillDisabled : undefined,
      });
      for (const task of overview ? sessionData.tasks.slice(0, 5) : sessionData.tasks) {
        const title = assistantTaskTitle(task);
        taskRows.push({
          id: `task:${task.id}`,
          name: title,
          section: "tasks",
          label: title,
          description: copy.commandTaskRunHint({ schedule: formatAssistantTaskScheduleInline(task, input.locale) }),
          icon: "ti ti-repeat",
          keywords: taskKeywords,
          busyLabel: copy.commandTaskStarting({ title }),
          reason:
            task.state === "paused"
              ? copy.commandTaskPaused
              : task.state === "needs_attention"
                ? copy.commandTaskNeedsAttention
                : undefined,
          action:
            task.state === "active"
              ? async () => {
                  try {
                    await assistantApi.runChatTask(task.id, { idempotencyKey: input.runKeys.runKey(task.id) });
                    input.runKeys.settleRun(task.id, { force: true });
                    return { done: copy.commandTaskRunning({ title }) };
                  } catch (error) {
                    const status = error instanceof AssistantTaskRunError ? error.status : undefined;
                    // A lost answer (network, 5xx) may hide an accepted start: keep its key and mark it uncertain.
                    // 408 and 429 were not processed but cannot disprove an earlier start, so they keep the key as is.
                    // Other 4xx settle a key that never had an unknown outcome; 404 always settles.
                    if (status === undefined || status >= 500) input.runKeys.runUncertain(task.id);
                    else if (status !== 408 && status !== 429) input.runKeys.settleRun(task.id, { force: status === 404 });
                    const reason =
                      status === undefined
                        ? copy.commandTaskOffline
                        : status >= 500
                          ? copy.commandTaskNoAnswer
                          : status === 409
                            ? copy.commandTaskAlreadyRunning
                            : status === 404
                              ? copy.commandTaskGone
                              : status === 429
                                ? copy.commandTaskTooMany
                                : copy.commandTaskNotAccepted;
                    // While an earlier or this attempt may have started the task, never claim it did not start.
                    const message = input.runKeys.isUncertain(task.id)
                      ? copy.commandTaskRunUnconfirmed({ title, reason })
                      : copy.commandTaskRunFailed({ title, reason });
                    throw new Error(message + " " + copy.draftUnchanged);
                  }
                }
              : undefined,
        });
      }
    }
  }
  // Tasks have their own overview bound and never lose rows to the reference limit.
  return [
    ...(fullSkillScope ? results : results.slice(0, 30)),
    ...taskRows.filter((row) => row.searchAgain || matchesChatCommand(row, query)),
  ];
}
