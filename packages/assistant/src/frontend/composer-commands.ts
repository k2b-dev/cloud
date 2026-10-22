import type { AiChatTaskView, AiProject, AiRecentResource, AiSkillSummary } from "@k2b/cloud/ai";
import { AI_TURN_ATTACHMENT_MAX_ITEMS, type AiComposerAttachment, aiChatAttachments, aiComposerAttachmentRecords } from "@k2b/cloud/ai/ui";
import { type CloudSearchTag, cloudInsertMenu } from "@k2b/cloud/browser/composer-insert";
import type { CloudResourcePickerItem } from "@k2b/cloud/browser/resource-picker";
import type { CloudResourceRef } from "@k2b/cloud/contracts";
import {
  type ChatAttachment,
  type ChatCommand,
  type ChatCommandResult,
  type ChatCommandScope,
  type ChatCommandSection,
  type ChatMention,
  type ChatModelOption,
  matchesChatCommand,
} from "@k2b/ui";
import { type Accessor, createSignal } from "solid-js";
import { AssistantTaskRunError, assistantApi } from "../api/client";
import { assistantMessages } from "./messages";
import { assistantTaskTitle, formatAssistantTaskScheduleInline } from "./scheduled-task-format";
import { type AssistantCopy, assistantCopyFor } from "./ui-copy";

export const assistantCommandSections = (copy: AssistantCopy, pending = false): ChatCommandSection[] => [
  // Only in the overview, and only with the rows it had when the list opened: it sits on top, so nothing may arrive late.
  { id: "recent", label: copy.commandRecent, overviewOnly: true, fixedWhileOpen: true },
  { id: "insert", label: copy.commandInsert },
  { id: "skills", label: copy.commandSkills, searched: true },
  { id: "files", label: copy.commandFiles, searched: true, searchOnly: true },
  { id: "chat", label: copy.commandChat },
  { id: "tasks", label: copy.commandTasks, searched: true },
  { id: "apps", label: copy.commandApps, pending },
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
  {
    id: "model",
    title: copy.commandModels,
    words: locale.startsWith("de") ? ["modell", "modelle", "model", "models"] : ["model", "models", "modell", "modelle"],
  },
  { id: "task", title: copy.commandTasks, words: ["routine", "routinen"] },
];

/**
 * The reference a chosen resource becomes in the text, with the id the saved draft rebuilds it with, so it keeps its
 * identity across saving and reopening. Studio apps are read by the Assistant as `assistant.artifact`.
 */
export const assistantResourceMention = (item: CloudResourcePickerItem): ChatAttachment => {
  const ref = item.ref.type === "assistant.app" ? { type: "assistant.artifact", id: item.ref.id } : item.ref;
  return aiChatAttachments([
    {
      kind: "resource",
      id: `resource:${ref.type}:${ref.id}`,
      name: item.title,
      ref,
      icon: item.icon ?? item.appIcon ?? "ti ti-cloud",
      href: item.href,
    },
  ])[0]!;
};

/** Resources the draft already holds, as attachments or references, by the refs it sends. */
export const assistantDraftRefs = (attachments: readonly AiComposerAttachment[], mentions: readonly ChatMention[]): CloudResourceRef[] =>
  [...attachments, ...aiComposerAttachmentRecords(mentions.map((mention) => mention.attachment))]
    .filter((attachment) => attachment.kind === "resource")
    .map(({ ref }) => ref);

/** Resources the draft already holds; the picker leaves them out. */
export const assistantExcludedRefs = (attachments: readonly AiComposerAttachment[], mentions: readonly ChatMention[]): CloudResourceRef[] =>
  // The picker lists Studio apps by their search type.
  assistantDraftRefs(attachments, mentions).map((ref) => (ref.type === "assistant.artifact" ? { type: "assistant.app", id: ref.id } : ref));

/**
 * Cloud insert rows share the draft's reference identity and the server's limit on non-text parts. Counts, not the
 * draft itself, so the rows keep their identity while someone types.
 */
export function assistantInsertCommands(input: {
  copy: AssistantCopy;
  locale: string;
  tags: readonly CloudSearchTag[];
  /** Attachments plus references in the text: the server counts both. */
  partCount: () => number;
  excludeRefs: () => readonly CloudResourceRef[];
  fileSelectionDisabled: boolean;
  /** Sees every open picker through, so the draft can wait with changes that would move it elsewhere. */
  track?: <T>(picking: Promise<T>) => Promise<T>;
}) {
  const t = assistantMessages.resolve([input.locale]).t;
  // Studio apps have no Cloud reader, so the catalog leaves their tag out; the Assistant adds it and reads them itself.
  const ownTag: CloudSearchTag = {
    appId: "assistant",
    appName: t.assistant,
    appIcon: "ti ti-sparkles",
    tag: "studio-app",
    title: input.copy.commandStudioApps,
    description: "",
    aliases: ["studio-apps", "studio"],
  };
  const tags = [...new Map([ownTag, ...input.tags].map((tag) => [`${tag.appId}:${tag.tag}`, tag])).values()];
  const limit = t.attachmentLimit({ count: AI_TURN_ATTACHMENT_MAX_ITEMS });
  const menu = cloudInsertMenu({
    locale: input.locale,
    tags,
    section: "insert",
    reservedWords: assistantCommandScopes(input.copy, input.locale).flatMap((scope) => scope.words),
    scopeWords: { "assistant:studio-app": ["app", "apps"] },
    // Studio apps have no Cloud reader; the Assistant reads them as `assistant.artifact`, as it did before.
    ownReaders: { "assistant:studio-app": "assistant.app" },
    reason: input.partCount() >= AI_TURN_ATTACHMENT_MAX_ITEMS ? limit : undefined,
    excludeRefs: input.excludeRefs,
    mention: assistantResourceMention,
  });
  const attach: ChatCommand = {
    id: "attach-files",
    section: "insert",
    name: "attach",
    label: input.copy.commandAttachFile,
    description: input.copy.commandAttachFileHint,
    icon: "ti ti-paperclip",
    keywords: ["datei", "dateien", "anhängen", "anhang", "hochladen", "upload", "attach", "file", "files", "attachment"],
    attachFiles: true,
    reason: input.fileSelectionDisabled
      ? input.copy.commandNeedsIdle
      : input.partCount() >= AI_TURN_ATTACHMENT_MAX_ITEMS
        ? limit
        : undefined,
  };
  const tracked = (command: ChatCommand): ChatCommand => {
    const { action, ...rest } = command;
    if (!action) return command;
    return {
      ...rest,
      action: (context) => {
        const picking = Promise.resolve(action(context)).then((result) => {
          // The count can grow while the picker is open.
          if (result && typeof result === "object" && "mention" in result && input.partCount() >= AI_TURN_ATTACHMENT_MAX_ITEMS)
            throw new Error(limit);
          return result;
        });
        return input.track ? input.track(picking) : picking;
      },
    };
  };
  return {
    commands: [tracked(menu.insert), attach, ...menu.tags.map(tracked)],
    scopes: menu.scopes,
    fallback: (search: { query: string; scope?: string }) => {
      const row = menu.fallback(search);
      return row && tracked(row);
    },
  };
}

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
const SKILL_TYPE = "core.ai.skill";
/**
 * The overview's Skills: the first four enabled ones besides those "Recent" may show. Those stay in the list too, with
 * the row key of their "Recent" row: when this opening shows "Recent", the composer keeps them only there; when it
 * opened before "Recent" arrived, they stay under Skills, so a Skill is never missing from both.
 */
export const overviewSkills = (skills: readonly AiSkillSummary[], recentShortIds: ReadonlySet<string> = new Set()) => {
  const shown: AiSkillSummary[] = [];
  let others = 0;
  for (const skill of skills) {
    if (others === OVERVIEW_SKILL_COUNT) break;
    if (!skill.enabled) continue;
    shown.push(skill);
    if (!recentShortIds.has(skill.shortId)) others++;
  }
  return shown;
};
/** One row key per Skill reference, the same under "Recent" and under "Skills", so the composer shows it once. */
const skillRowId = (shortId: string) => `resource:${SKILL_TYPE}:${shortId}`;

/** "Recent" in the overview: the server checks up to eight, the overview shows the four sent most often. */
export const RECENT_OVERVIEW_COUNT = 4;

/**
 * The server checks every reference within one Capability query budget (15 seconds) and then answers with what it
 * has; the extra time lets that answer travel back, so one stalled app does not hide the others.
 */
const RECENT_LOAD_TIMEOUT_MS = 20_000;
const recentLoads = new Map<string, Promise<readonly AiRecentResource[]>>();

/**
 * References this person recently sent, checked by the server with each app's reader. One load per page and locale,
 * shared by every composer; it starts when a composer mounts. A failed load is forgotten, so the next list opening asks
 * again; nothing polls. `items` stays `undefined` until an answer arrives.
 */
export function createAssistantRecentResources(
  load: (signal: AbortSignal) => Promise<readonly AiRecentResource[]> = assistantApi.listRecentResources,
) {
  const [items, setItems] = createSignal<readonly AiRecentResource[]>();
  let current: string | undefined;
  let opening: number | undefined;
  let openedWith: readonly AiRecentResource[] | undefined;
  return {
    items: items as Accessor<readonly AiRecentResource[] | undefined>,
    /**
     * Call at every `searchCommands` run: only a new list opening asks again after a failure, no keystroke does.
     * Returns the references this opening had at its first search, for the overview's Skills: an answer that arrives
     * later must not change which Skills the same open list shows.
     */
    opened(search: { opening: number }, locale: string) {
      if (opening === search.opening) return openedWith;
      opening = search.opening;
      openedWith = items();
      this.ensure(locale);
      return openedWith;
    },
    /** Starts or reuses the page's load for `locale`. Call when the composer mounts. */
    ensure(locale: string) {
      let pending = recentLoads.get(locale);
      if (!pending) {
        // The server reads under one Capability query budget; the same bound ends a request that never answers.
        const started: Promise<readonly AiRecentResource[]> = load(AbortSignal.timeout(RECENT_LOAD_TIMEOUT_MS)).catch((error: unknown) => {
          if (recentLoads.get(locale) === started) recentLoads.delete(locale);
          throw error;
        });
        pending = started;
        recentLoads.set(locale, pending);
      }
      if (current === locale && items() !== undefined) return;
      current = locale;
      pending.then(
        (loaded) => {
          if (current === locale) setItems(loaded);
        },
        () => undefined,
      );
    },
  };
}
/** Only for tests: forget the page's loads. */
export const resetAssistantRecentResources = () => recentLoads.clear();

/**
 * One recent reference as a row. Choosing it checks the live part count, as the picker rows do: attachments can arrive
 * while the list is open, and the server rejects a message with more parts.
 */
const recentRow = (
  item: AiRecentResource,
  section: string,
  limit: { partCount: () => number; locale: string },
  recent = false,
): ChatCommand => {
  const attachment = aiChatAttachments([
    {
      kind: "resource",
      id: `resource:${item.ref.type}:${item.ref.id}`,
      name: item.title,
      ref: item.ref,
      icon: item.icon ?? "ti ti-cloud",
      ...(item.href ? { href: item.href } : {}),
    },
  ])[0]!;
  const reason = recentLimitReason(limit.partCount(), limit.locale);
  return {
    id: attachment.id,
    section,
    name: item.title,
    label: item.title,
    // Kind and place, such as "Note · Sales"; without a place the app says where it lives.
    description: `${item.kind} · ${item.preview ?? item.appName}`,
    icon: item.icon ?? "ti ti-cloud",
    keywords: [item.kind, item.appName],
    app: item.appName,
    action: () => {
      const full = recentLimitReason(limit.partCount(), limit.locale);
      if (full) throw new Error(full);
      return { mention: attachment };
    },
    ...(reason ? { reason } : {}),
    ...(recent ? { recent: true } : {}),
  };
};

const recentKey = (ref: CloudResourceRef) => `${ref.type}\u0000${ref.id}`;

/** Most often sent first, then most recently: the server answers in recency order. Actions are never sorted this way. */
export const assistantRecentOverview = (items: readonly AiRecentResource[]) =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.count - a.item.count || a.index - b.index)
    .slice(0, RECENT_OVERVIEW_COUNT)
    .map(({ item }) => item);

/**
 * The overview's "Recent" rows. References the draft already holds are left out, as the picker leaves them out; a full
 * message gives every row the same reason as the other insert rows.
 */
export function assistantRecentCommands(input: {
  items: readonly AiRecentResource[] | undefined;
  excludeRefs: readonly CloudResourceRef[];
  /** Attachments plus references in the text: the server counts both. */
  partCount: () => number;
  locale: string;
}): ChatCommand[] {
  const excluded = new Set(input.excludeRefs.map(recentKey));
  return assistantRecentOverview((input.items ?? []).filter((item) => !excluded.has(recentKey(item.ref)))).map((item) =>
    recentRow(item, "recent", input),
  );
}

const recentLimitReason = (partCount: number, locale: string) =>
  partCount >= AI_TURN_ATTACHMENT_MAX_ITEMS
    ? assistantMessages.resolve([locale]).t.attachmentLimit({ count: AI_TURN_ATTACHMENT_MAX_ITEMS })
    : undefined;

/** Tags whose references the Assistant reads itself under another type: Studio apps are sent as `assistant.artifact`. */
const OWN_RECENT_TYPES: Readonly<Record<string, string>> = { "assistant:studio-app": "assistant.artifact" };

/**
 * A tag scope such as "/notiz" lists recent references of its kind: those whose type is the tag's app and whose local
 * type id equals the tag (`notebooks:note` ↔ `notebooks.note`). Other references appear only in unscoped search.
 */
const recentInTagScope = (scope: string, ref: CloudResourceRef) => {
  if (!scope.startsWith("cloud-tag:")) return false;
  const tagKey = scope.slice("cloud-tag:".length);
  return ref.type === (OWN_RECENT_TYPES[tagKey] ?? tagKey.replace(":", "."));
};

/** The menu lists at most three task states of 100 each, so one key per listable task fits. */
export const MAX_PENDING_RUN_KEYS = 300;

/** Keeps pending task starts across composer remounts and reloads in one tab. */
export function createAssistantTaskRunKeys(storage?: Pick<Storage, "getItem" | "setItem">) {
  const storageKey = "k2b.assistant.taskRunKeys";
  const pendingRunKeys = new Map<string, { key: string; uncertain: boolean }>();
  let loaded = false;
  // Oldest first, and keys without an unknown outcome before the ones that guard against a duplicate start.
  const trim = () => {
    for (const uncertain of [false, true])
      for (const [taskId, pending] of pendingRunKeys) {
        if (pendingRunKeys.size <= MAX_PENDING_RUN_KEYS) return;
        if (pending.uncertain === uncertain) pendingRunKeys.delete(taskId);
      }
  };
  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      storage ??= globalThis.sessionStorage;
      const entries: unknown = JSON.parse(storage?.getItem(storageKey) ?? "null");
      if (!Array.isArray(entries)) return;
      for (const candidate of entries) {
        const entry: unknown = candidate;
        if (
          entry &&
          typeof entry === "object" &&
          "taskId" in entry &&
          typeof entry.taskId === "string" &&
          "key" in entry &&
          typeof entry.key === "string" &&
          /^[a-f0-9]{32}$/.test(entry.key) &&
          "uncertain" in entry &&
          typeof entry.uncertain === "boolean"
        ) {
          // A key restored after a reload may belong to a request whose answer never arrived.
          pendingRunKeys.set(entry.taskId, { key: entry.key, uncertain: true });
          trim();
        }
      }
    } catch {
      // Storage can be unavailable, or contain invalid JSON; memory still works.
    }
  };
  const save = () => {
    trim();
    try {
      storage?.setItem(storageKey, JSON.stringify([...pendingRunKeys].map(([taskId, pending]) => ({ taskId, ...pending }))));
    } catch {
      // Privacy settings and quota failures must not prevent a task start.
    }
  };
  return {
    runKey(taskId: string) {
      load();
      let pending = pendingRunKeys.get(taskId);
      if (!pending) {
        pending = { key: crypto.randomUUID().replaceAll("-", ""), uncertain: false };
        pendingRunKeys.set(taskId, pending);
        save();
      }
      return pending.key;
    },
    runUncertain(taskId: string) {
      load();
      const pending = pendingRunKeys.get(taskId);
      if (pending && !pending.uncertain) {
        pending.uncertain = true;
        save();
      }
    },
    isUncertain(taskId: string) {
      load();
      return pendingRunKeys.get(taskId)?.uncertain === true;
    },
    settleRun(taskId: string, { force = false }: { force?: boolean } = {}) {
      load();
      if ((force || !pendingRunKeys.get(taskId)?.uncertain) && pendingRunKeys.delete(taskId)) save();
    },
  };
}

/** Owns discovery per opening for one composer. */
export function createAssistantCommandSession() {
  let latest:
    | {
        session: number;
        abort: AbortController;
        skills: Promise<AiSkillSummary[] | null>;
        data: Promise<{ skills: AiSkillSummary[] | null; scheduledTaskSkills: AiSkillSummary[] | null; tasks: AiChatTaskView[] | null }>;
      }
    | undefined;
  return {
    /** The opening's full Skill list alone, so the Skill scope never waits for task discovery. */
    loadSkills(session: number) {
      this.load(session);
      return latest!.skills;
    },
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
      latest = { session, abort, skills, data };
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
  /** Checked recent references, once loaded; they rank first while searching and fill tag scopes. */
  recent?: readonly AiRecentResource[];
  /**
   * The recent references of this list opening, as `opened` returns them; the overview's Skills follow these, so a
   * later answer never adds a Skill row to the open list. `recent` when left out.
   */
  recentAtOpening?: readonly AiRecentResource[];
  /** References the draft already holds; recent rows leave them out. */
  excludeRefs?: readonly CloudResourceRef[];
  /** Attachments plus references in the text, for the insert limit; read again when a recent row is chosen. */
  partCount?: () => number;
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
  const excluded = new Set((input.excludeRefs ?? []).map(recentKey));
  const recent = (input.recent ?? []).filter((item) => !excluded.has(recentKey(item.ref)));
  const recentSkills = new Set(recent.filter((item) => item.ref.type === SKILL_TYPE).map((item) => item.ref.id));
  const recentLimit = { partCount: input.partCount ?? (() => 0), locale: input.locale };
  const [sessionData, searchedSkills, chatFiles, project] = await Promise.all([
    wants("task") ? input.sessionLoader.load(input.session) : null,
    wants("skill") && !overview && !fullSkillScope ? assistantApi.listSkills(input.signal, query.slice(0, 200)) : [],
    (category === "file" || (!category && query.length > 0)) && input.conversationId
      ? assistantApi.listChatFiles(input.conversationId, input.signal)
      : [],
    (category === "file" || (!category && query.length > 0)) && input.projectId
      ? assistantApi.loadProjectContext(input.projectId, input.signal)
      : null,
  ]);
  const allSkills = fullSkillScope ? await input.sessionLoader.loadSkills(input.session) : sessionData?.skills;
  const results: ChatCommand[] = [];
  // Typed text: recent references rank first among the insert rows. A tag scope lists the recent ones of its kind.
  if (!category && query)
    for (const item of recent)
      if (item.ref.type !== SKILL_TYPE) {
        const row = recentRow(item, "insert", recentLimit, true);
        if (matchesChatCommand(row, query)) results.push(row);
      }
  if (category?.startsWith("cloud-tag:"))
    for (const item of recent)
      if (recentInTagScope(category, item.ref)) {
        const row = recentRow(item, "insert", recentLimit, true);
        if (matchesChatCommand(row, query)) results.push(row);
      }
  // An opening that had no answer yet passes `undefined`, which must not fall back to the live answer.
  const recentAtOpening = (("recentAtOpening" in input ? input.recentAtOpening : input.recent) ?? []).filter(
    (item) => !excluded.has(recentKey(item.ref)),
  );
  const shownRecentSkills = overview
    ? new Set(assistantRecentOverview(recentAtOpening).flatMap((item) => (item.ref.type === SKILL_TYPE ? [item.ref.id] : [])))
    : new Set<string>();
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
  for (const skill of overview ? overviewSkills(allSkills ?? [], shownRecentSkills) : fullSkillScope ? (allSkills ?? []) : searchedSkills) {
    if (!skill.enabled) continue;
    const row = {
      ...reference("skills", skill.name, `Skill · ${skill.description}`, {
        kind: "resource",
        id: `skill:${skill.id}`,
        name: skill.name,
        ref: { type: SKILL_TYPE, id: skill.shortId },
        icon: "ti ti-sparkles",
      }),
      id: skillRowId(skill.shortId),
    };
    results.push(!overview && recentSkills.has(skill.shortId) ? { ...row, recent: true } : row);
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
      // Skill names are unique, so the app-provided result of the exact-name lookup is the scheduled-tasks Skill.
      const skill = sessionData.scheduledTaskSkills.find((skill) => skill.source !== null);
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
                    const state = await assistantApi.runChatTask(task.id, { idempotencyKey: input.runKeys.runKey(task.id) });
                    input.runKeys.settleRun(task.id, { force: true });
                    return {
                      done:
                        state === "completed"
                          ? copy.commandTaskAlreadyRan({ title })
                          : state === "failed"
                            ? copy.commandTaskAlreadyFailed({ title })
                            : state === "stopped"
                              ? copy.commandTaskAlreadyStopped({ title })
                              : copy.commandTaskRunning({ title }),
                    };
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
