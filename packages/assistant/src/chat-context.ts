import { sql } from "@k2b/cloud";
import {
  type AiConversationSkillUse,
  type AiConversationSource,
  type AiConversationSourceKind,
  type AiConversationWorkingGroup,
  type AiFileStat,
  type AiResourceContext,
  type AiChatTaskView as AssistantChatTask,
  aiChatTasks,
  aiConversations,
  aiMemories,
  aiSkills,
  loadAiConversationFileOverview,
  toAiChatTaskView,
} from "@k2b/cloud/ai";

/** Snapshot limits: results and files come from people and stay small; sources and working files can grow. */
const RESULT_LIMIT = 500;
const FILE_LIMIT = 500;
const WORKING_GROUP_LIMIT = 200;
const LOOSE_WORKING_FILE_LIMIT = 100;
const SOURCE_PAGE = 100;

/** Something the assistant delivered in this chat. */
export type AssistantChatResult = {
  key: string;
  kind: "file" | "visualization";
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
  runCount: number;
  runs: Array<{ id: string; status: string; createdAt: string }>;
};

const readableSources = (sources: readonly AiConversationSource[]) =>
  sources.filter((source) => !["assistant.artifact", "assistant.app"].includes(source.ref?.type ?? ""));
/**
 * One page of the chat's sources for the sidebar's "Load more" and its search, excluding retired resources.
 * `null` when the chat does not exist for the viewer.
 */
export const loadAssistantChatSources = async (
  identity: AiResourceContext,
  chatId: string,
  query: { q?: string; cursor?: string; limit?: number; kinds?: AiConversationSourceKind[]; observed?: boolean },
): Promise<{ sources: AiConversationSource[]; nextCursor?: string; total: number } | null> => {
  if (identity.accessSubject.type !== "user") throw new Error("A user-backed identity is required.");
  const userId = identity.accessSubject.userId;
  const conversation = await aiConversations.getConversationByShortId({ shortId: chatId, ownerUserId: userId });
  if (!conversation) return null;
  const page = await aiConversations.listConversationSources({
    conversationId: conversation.id,
    search: query.q,
    before: query.cursor,
    limit: query.limit,
    kinds: query.kinds,
    observed: query.observed,
  });
  return { ...page, sources: readableSources(page.sources) };
};

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
  identity: AiResourceContext,
  chatId: string,
  options: { timeZone: string },
): Promise<AssistantChatContextSnapshot | null> => {
  if (identity.accessSubject.type !== "user") throw new Error("A user-backed identity is required.");
  const userId = identity.accessSubject.userId;
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
  // An upload stays the person's file, also when the assistant hands it over with present.
  const uploads = new Set(overview.files.flatMap((file) => (file.origin === "user" ? [file.path] : [])));
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
      if (source.size === null || source.mediaType === null || uploads.has(source.path)) return [];
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
    return [];
  });
  const runs = await sql<{ id: string; status: string; createdAt: string }[]>`SELECT run.call_id AS id,
    CASE WHEN latest.status='done' THEN CASE WHEN latest.result->>'busy'='true' OR latest.result->'work'->>'status'='running' THEN 'running' ELSE COALESCE(latest.result->>'status','unknown') END ELSE COALESCE(latest.status,run.status) END AS status,
    run.created_at::text AS "createdAt" FROM assistant.code_agent_calls run
    LEFT JOIN LATERAL(SELECT state.status,state.result FROM assistant.code_agent_calls state
      WHERE state.conversation_id=run.conversation_id AND (state.result->>'runId'=run.call_id OR state.input->>'runId'=run.call_id) AND (state.result ? 'status' OR state.status != 'done')
      ORDER BY state.updated_at DESC LIMIT 1) latest ON true
    WHERE run.conversation_id=${conversation.id}::uuid AND run.user_id=${userId}::uuid
      AND run.input->>'operation'='run' AND run.input->>'id' IS NULL ORDER BY run.created_at DESC LIMIT 20`;
  const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM assistant.code_agent_calls
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
    sources: readableSources(sourcePage.sources),
    sourceCount: sourcePage.total,
    sourceCursor: sourcePage.nextCursor ?? null,
    tasks: tasks.map(toAiChatTaskView),
    skills,
    memories: memories.map((memory) => ({ id: memory.shortId, content: memory.content })),
    runCount: count?.count ?? 0,
    runs,
  };
};
