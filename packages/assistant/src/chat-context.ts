import {
  type AiConversationSkillUse,
  type AiConversationSource,
  type AiConversationWorkingGroup,
  type AiFileStat,
  type AiChatTaskView as AssistantChatTask,
  aiChatTasks,
  aiConversations,
  aiMemories,
  aiProjects,
  aiSkills,
  loadAiConversationFileOverview,
  toAiChatTaskView,
} from "@k2b/cloud/ai";
import { sql } from "bun";
import { type ArtifactSummary, artifacts } from "./artifacts/service";

/** Snapshot limits: results and files come from people and stay small; sources and working files can grow. */
const RESULT_LIMIT = 500;
const FILE_LIMIT = 500;
const WORKING_GROUP_LIMIT = 200;
const LOOSE_WORKING_FILE_LIMIT = 100;
const SOURCE_PAGE = 100;

/** Something the assistant delivered in this chat. */
export type AssistantChatResult = {
  key: string;
  kind: "file" | "app" | "visualization";
  title: string;
  /** The one-sentence description the assistant gave when delivering it. */
  description: string | null;
  icon: string;
  /** When it was last delivered; a new delivery moves it to its new turn. */
  deliveredAt: string;
  turnId: string | null;
  callId: string | null;
  /** Chat position of the delivery, for `?message=`; null when its turn is gone. */
  messageSeq: number | null;
  file?: { path: string; mediaType: string; size: number };
  /** `href` opens the app on its own page: the editor for admins, the runner otherwise. */
  app?: { id: string; href: string; published: boolean; lastRun: "ready" | "error" | "running" | null };
  presentationId?: string;
};

export type AssistantChatContextSnapshot = {
  chatId: string;
  viewerUserId: string;
  /** Server time and the viewer's time zone: both renders group by date from these, so the first frame is final. */
  now: string;
  timeZone: string;
  results: AssistantChatResult[];
  /** True when the chat has more results than the snapshot carries; search reaches all of them. */
  resultsTruncated: boolean;
  /** Files outside the working folder: uploads, results, and other assistant files. */
  files: AiFileStat[];
  fileCount: number;
  /** Working files below `/temp/`: one group per first folder, and the files directly in `/temp/`. */
  working: { groups: AiConversationWorkingGroup[]; groupCount: number; looseFiles: AiFileStat[]; count: number; bytes: number };
  storage: { usedBytes: number; maxBytes: number };
  /** Web pages, searches, and Cloud items a tool call read; newest first. */
  sources: AiConversationSource[];
  sourceCount: number;
  /** Cursor for the sources after `sources`; null when the snapshot holds all of them. */
  sourceCursor: string | null;
  tasks: AssistantChatTask[];
  skills: AiConversationSkillUse[];
  memories: Array<{ id: string; content: string }>;
  /** Studio overview: apps this chat referenced, and its one-off runs. */
  apps: ArtifactSummary[];
  runCount: number;
  runs: Array<{ id: string; status: string; createdAt: string }>;
};

const runState = (status: string | undefined): "ready" | "error" | "running" | null =>
  status === "ready" || status === "error" || status === "running" ? status : null;

const resultSources = async (conversationId: string) => {
  const sources: AiConversationSource[] = [];
  let before: string | undefined;
  do {
    const page = await aiConversations.listConversationSources({ conversationId, kinds: ["result"], limit: 100, before });
    sources.push(...page.sources);
    before = page.nextCursor;
  } while (before && sources.length < RESULT_LIMIT);
  return { sources: sources.slice(0, RESULT_LIMIT), truncated: Boolean(before) };
};

export const loadAssistantChatContextSnapshot = async (
  userId: string,
  chatId: string,
  options: { timeZone: string },
): Promise<AssistantChatContextSnapshot | null> => {
  const conversation = await aiConversations.getConversationByShortId({ shortId: chatId, ownerUserId: userId });
  if (!conversation) return null;
  const now = new Date().toISOString();
  const [delivered, sourcePage, overview, tasks, skills, memories] = await Promise.all([
    resultSources(conversation.id),
    aiConversations.listConversationSources({
      conversationId: conversation.id,
      kinds: ["web", "activity", "resource"],
      observed: true,
      limit: SOURCE_PAGE,
    }),
    loadAiConversationFileOverview(conversation.id, {
      files: FILE_LIMIT,
      groups: WORKING_GROUP_LIMIT,
      looseWorkingFiles: LOOSE_WORKING_FILE_LIMIT,
    }),
    aiChatTasks.list({ userId, chatId, limit: 100 }),
    aiSkills.listConversationUses(conversation.id),
    aiMemories.listFromConversation(userId, conversation.id),
  ]);
  const project = conversation.projectId ? await aiProjects.get(conversation.projectId, { type: "user", userId }, "read") : null;
  const projectRefs = project ? await aiProjects.listReferences(project.id, { type: "user", userId }) : [];
  const resultAppIds = delivered.sources.flatMap((source) => (source.ref?.type === "assistant.artifact" ? [source.ref.id] : []));
  const appIds = [
    ...new Set([
      ...resultAppIds,
      ...sourcePage.sources.flatMap((source) => (source.ref?.type === "assistant.artifact" ? [source.ref.id] : [])),
      ...projectRefs.flatMap((reference) => (reference.ref.type === "assistant.artifact" ? [reference.ref.id] : [])),
    ]),
  ];
  const apps = new Map((await artifacts.describe(appIds, userId, conversation.id)).map((app) => [app.id, app]));
  const lastRuns = resultAppIds.length
    ? await sql<{ id: string; revision: number; status: string }[]>`SELECT DISTINCT ON(result->>'id') result->>'id' AS id,
    (result->>'revision')::int AS revision,CASE WHEN result->>'busy'='true' OR result->'work'->>'status'='running' THEN 'running' ELSE result->>'status' END AS status FROM assistant.artifact_agent_calls
    WHERE conversation_id=${conversation.id}::uuid AND user_id=${userId}::uuid
      AND result->>'id' IN ${sql([...new Set(resultAppIds)])} AND status='done' AND result->>'revision' ~ '^[0-9]+$'
    ORDER BY result->>'id',updated_at DESC`
    : [];
  const checks = new Map(lastRuns.map((run) => [run.id, run]));
  const visualizationCalls = delivered.sources.flatMap((source) =>
    source.key.startsWith("code_present:") && source.sourceCallId ? [source.sourceCallId] : [],
  );
  const presentations = visualizationCalls.length
    ? new Map(
        (
          await sql<{ id: string; call_id: string; title: string }[]>`SELECT id::text AS id,call_id,title FROM assistant.chat_presentations
            WHERE conversation_id=${conversation.id}::uuid AND call_id IN ${sql(visualizationCalls)}`
        ).map((row) => [row.call_id, row]),
      )
    : new Map<string, { id: string; title: string }>();
  const results = delivered.sources.flatMap((source): AssistantChatResult[] => {
    const base = {
      key: source.key,
      description: source.preview,
      deliveredAt: source.lastSeenAt,
      turnId: source.sourceTurnId,
      callId: source.sourceCallId,
      messageSeq: source.sourceMessageSeq,
    };
    if (source.path) {
      // A result counts only while its file exists.
      if (source.size === null || source.mediaType === null) return [];
      return [
        {
          ...base,
          kind: "file",
          title: source.title,
          icon: source.icon,
          file: { path: source.path, mediaType: source.mediaType, size: source.size },
        },
      ];
    }
    if (source.ref?.type === "assistant.artifact") {
      const app = apps.get(source.ref.id);
      if (!app) return [];
      const check = checks.get(app.id);
      const lastRun = check?.revision === app.revision ? runState(check.status) : null;
      return [
        {
          ...base,
          kind: "app",
          title: app.title,
          description: base.description ?? app.description ?? null,
          icon: app.icon ?? "ti ti-app-window",
          app: {
            id: app.id,
            href: `/app/assistant/apps/${app.id}${app.permission === "admin" ? "" : "/run"}`,
            published: Boolean(app.publishedVersion),
            lastRun,
          },
        },
      ];
    }
    const presentation = source.sourceCallId ? presentations.get(source.sourceCallId) : undefined;
    if (!presentation) return [];
    return [{ ...base, kind: "visualization", title: presentation.title, icon: source.icon, presentationId: presentation.id }];
  });
  const runs = await sql<{ id: string; status: string; createdAt: string }[]>`SELECT run.call_id AS id,
    CASE WHEN latest.status='done' THEN CASE WHEN latest.result->>'busy'='true' OR latest.result->'work'->>'status'='running' THEN 'running' ELSE COALESCE(latest.result->>'status','unknown') END ELSE COALESCE(latest.status,run.status) END AS status,
    run.created_at::text AS "createdAt" FROM assistant.artifact_agent_calls run
    LEFT JOIN LATERAL(SELECT state.status,state.result FROM assistant.artifact_agent_calls state
      WHERE state.conversation_id=run.conversation_id AND (state.result->>'runId'=run.call_id OR state.input->>'runId'=run.call_id) AND (state.result ? 'status' OR state.status != 'done')
      ORDER BY state.updated_at DESC LIMIT 1) latest ON true
    WHERE run.conversation_id=${conversation.id}::uuid AND run.user_id=${userId}::uuid
      AND run.input->>'operation'='run' AND run.input->>'id' IS NULL ORDER BY run.created_at DESC LIMIT 20`;
  const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM assistant.artifact_agent_calls
    WHERE conversation_id=${conversation.id}::uuid AND user_id=${userId}::uuid
      AND input->>'operation'='run' AND input->>'id' IS NULL`;
  return {
    chatId,
    viewerUserId: userId,
    now,
    timeZone: options.timeZone,
    results,
    resultsTruncated: delivered.truncated,
    files: overview.files,
    fileCount: overview.fileCount,
    working: {
      groups: overview.groups,
      groupCount: overview.groupCount,
      looseFiles: overview.looseWorkingFiles,
      count: overview.workingCount,
      bytes: overview.workingBytes,
    },
    storage: { usedBytes: overview.usedBytes, maxBytes: overview.maxBytes },
    // An app shows only while the viewer may still read it, and under its current title.
    sources: sourcePage.sources.flatMap((source) => {
      if (source.ref?.type !== "assistant.artifact") return [source];
      const app = apps.get(source.ref.id);
      return app ? [{ ...source, title: app.title, icon: app.icon ?? source.icon }] : [];
    }),
    sourceCount: sourcePage.total,
    sourceCursor: sourcePage.nextCursor ?? null,
    tasks: tasks.map(toAiChatTaskView),
    skills,
    memories: memories.map((memory) => ({ id: memory.shortId, content: memory.content })),
    apps: [...apps.values()],
    runCount: count?.count ?? 0,
    runs,
  };
};
