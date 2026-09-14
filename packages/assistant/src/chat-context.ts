import { sql } from "bun";
import { artifacts } from "./artifacts/service";
import { type AiConversationSource, type AiFileStat, aiProjects, aiChatTasks, aiConversations, listAiConversationFiles } from "@k2b/cloud/ai";
import { type AiChatTaskView as AssistantChatTask, toAiChatTaskView } from "@k2b/cloud/ai";

export type AssistantChatContextSnapshot = {
  chatId: string;
  sources: AiConversationSource[];
  files: AiFileStat[];
  tasks: AssistantChatTask[];
  viewerUserId: string;
  apps: import("./artifacts/service").ArtifactSummary[];
  runCount: number;
  runs: Array<{id:string;status:string;createdAt:string}>;
};

export const loadAssistantChatContextSnapshot = async (userId: string, chatId: string, locale: string): Promise<AssistantChatContextSnapshot | null> => {
  const conversation = await aiConversations.getConversationByShortId({ shortId: chatId, ownerUserId: userId });
  if (!conversation) return null;
  const [sourcePage, files, tasks] = await Promise.all([
    aiConversations.listConversationSources({ conversationId: conversation.id, limit: 100 }),
    listAiConversationFiles(conversation.id),
    aiChatTasks.list({ userId, chatId, limit: 100 }),
  ]);
  while (sourcePage.nextCursor) {
    const next = await aiConversations.listConversationSources({ conversationId: conversation.id, limit: 100, before: sourcePage.nextCursor });
    sourcePage.sources.push(...next.sources);
    sourcePage.nextCursor = next.nextCursor;
  }
  const project = conversation.projectId ? await aiProjects.get(conversation.projectId, { type: "user", userId }, "read") : null;
  const projectRefs = project ? await aiProjects.listReferences(project.id, { type: "user", userId }) : [];
  const appIds = [...new Set([
    ...sourcePage.sources.flatMap(source => source.ref?.type === "assistant.artifact" ? [source.ref.id] : []),
    ...projectRefs.flatMap(reference => reference.ref.type === "assistant.artifact" ? [reference.ref.id] : []),
  ])];
  const apps = new Map((await artifacts.describe(appIds, userId, conversation.id)).map(app => [app.id, app]));
  const lastRuns = appIds.length ? await sql<{id:string;revision:number;status:string}[]>`SELECT DISTINCT ON(result->>'id') result->>'id' AS id,
    (result->>'revision')::int AS revision,CASE WHEN result->>'busy'='true' OR result->'work'->>'status'='running' THEN 'running' ELSE result->>'status' END AS status FROM assistant.artifact_agent_calls
    WHERE conversation_id=${conversation.id}::uuid AND user_id=${userId}::uuid
      AND result->>'id' IN ${sql(appIds)} AND status='done' AND result->>'revision' ~ '^[0-9]+$'
    ORDER BY result->>'id',updated_at DESC` : [];
  const checks = new Map(lastRuns.map(run=>[run.id,run]));
  const de=locale.startsWith("de");
  const sources = sourcePage.sources.flatMap(source => {
    if (source.ref?.type !== "assistant.artifact") return [source];
    const app = apps.get(source.ref.id);
    if (!app) return [];
    const check=checks.get(app.id);
    const status=check?.revision===app.revision ? (check.status==="ready" ? (de?"Lauf erfolgreich":"Run succeeded") : check.status==="error" ? (de?"Lauf fehlgeschlagen":"Run failed") : (de?"Lauf nicht abgeschlossen":"Run incomplete")) : (de?"Revision noch nicht ausgeführt":"Revision not run yet");
    const preview=[app.kind==="app"?"App":(de?"Skript":"Script"),`R${app.revision}`,app.publishedVersion ? `${de?"Veröffentlicht":"Published"} v${app.publishedVersion}` : (de?"Entwurf":"Draft"),status,app.description].filter(Boolean).join(" · ");
    return [{ ...source, title: app.title, icon: app.icon, preview }];
  });
  const runs=await sql<{id:string;status:string;createdAt:string}[]>`SELECT run.call_id AS id,
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
    viewerUserId: userId,
    apps: [...apps.values()],
    runCount: count?.count ?? 0,
    chatId,
    runs,
    sources,
    files,
    tasks: tasks.map(toAiChatTaskView),
  };
};
