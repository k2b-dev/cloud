import { sql } from "bun";
import { AiUsageQuerySchema, type AiUsageQuery } from "../shared/ai-usage";
export { AI_USAGE_RANGES, type AiUsageRange } from "../shared/ai-usage";

export type AiUsageRun = {
  id: string;
  kind: "chat" | "background" | "tool";
  task: string;
  status: string;
  createdAt: string;
  userId: string | null;
  userLabel: string | null;
  modelProfileId: string | null;
  providerModel: string | null;
  appId: string | null;
  conversationId: string | null;
  turnId: string | null;
  workflowRunId: string | null;
  traceId: string | null;
  tokens: number | null;
  credits: number | null;
  durationMs: number | null;
  errorCode: string | null;
  error: string | null;
  attempts: number | null;
};
export type AiUsageFeedback = {
  id: string;
  conversationId: string;
  conversationTitle: string;
  userId: string | null;
  userLabel: string | null;
  modelProfileId: string | null;
  providerModel: string | null;
  rating: "up" | "down";
  reasons: string[];
  comment: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AiUsageStats = {
  runs: number;
  failed: number;
  tokens: number | null;
  credits: number | null;
  tokenCoverage: number;
  creditsCoverage: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  avgOutputTokensPerSecond: number | null;
  switchesAway: number;
  assistantMessages: number;
  positive: number;
  negative: number;
  rated: number;
};
export type AiUsageGroup = AiUsageStats & { id: string | null; label: string | null; providerModel?: string | null; capabilities: number };
export type AiUsagePoint = { bucket: string; turns: number; tokens: number | null; failed: number; credits: number | null };
export type AiUsagePagination = { page: number; perPage: number; total: number };
export type AiUsagePage<T> = AiUsagePagination & { items: T[] };
export type AiUsageReport = {
  query: AiUsageQuery;
  since: string;
  until: string;
  overview: AiUsageStats;
  chat: AiUsageStats;
  background: AiUsageStats;
  tool: AiUsageStats;
  unassignedBackgroundRuns: number;
  timeline: AiUsagePoint[];
  users: AiUsagePage<AiUsageGroup>;
  models: AiUsagePage<AiUsageGroup>;
  launches: AiUsagePage<AiUsageLaunch>;
  capabilities: AiUsagePage<AiUsageGroup>;
  tasks: AiUsagePage<AiUsageGroup>;
  apps: AiUsagePage<AiUsageGroup>;
  feedback: AiUsagePage<AiUsageFeedback>;
  runs: AiUsagePage<AiUsageRun>;
};
export type AiUsageReportOptions = Partial<AiUsageQuery>;
// Aggregate rows share the same coverage and feedback definitions across dimensions.
export type AiUsageOverview = AiUsageStats;
export type AiUsageModel = AiUsageGroup;
export type AiUsageUser = AiUsageGroup;
export type AiUsageCapability = AiUsageGroup;
export type AiUsageBackgroundTask = AiUsageGroup;
export type AiUsageLaunch = { appId: string; chats: number; users: number };

const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const period = (input: Partial<AiUsageQuery>) => {
  const query = AiUsageQuerySchema.parse(input);
  const until = query.until ? new Date(query.until) : new Date();
  const since = new Date(until.getTime() - days[query.range] * 86400000);
  return { query: { ...query, until: until.toISOString() }, since, until };
};

/** One row per durable event. Tool events have no inference charge. No message content leaves this projection. */
const events = (since: Date, until: Date) => sql`
  SELECT t.id::text, 'chat'::text AS kind, 'chat'::text AS task, t.status,
    t.created_at, c.created_by_user_id AS user_id, c.id AS conversation_id, t.id AS turn_id,
    NULL::uuid AS workflow_run_id, NULL::text AS trace_id,
    t.model_profile_id, t.provider_model, c.launched_by_app_id AS app_id,
    NULLIF(t.usage->>'total','')::double precision AS tokens,
    NULLIF(t.usage->>'creditsUsed','')::double precision AS credits,
    NULLIF(t.loop_aggregate #>> '{timing,generationMs}','')::double precision AS duration_ms,
    NULL::text AS error_code, t.error, t.attempt AS attempts,
    f.messages AS assistant_messages, f.positive, f.negative,
    NULLIF(t.loop_aggregate #>> '{timing,outputTokensPerSecond}','')::double precision AS speed,
    CASE WHEN lead(t.id) OVER next_turn IS NOT NULL AND
      (lead(t.model_profile_id) OVER next_turn IS DISTINCT FROM t.model_profile_id OR lead(t.provider_model) OVER next_turn IS DISTINCT FROM t.provider_model)
      THEN 1 ELSE 0 END AS switches

  FROM ai.turns t JOIN ai.conversations c ON c.id = t.conversation_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS messages, count(*) FILTER (WHERE feedback_rating=1)::int AS positive,
      count(*) FILTER (WHERE feedback_rating=-1)::int AS negative
    FROM ai.messages m WHERE m.conversation_id=t.conversation_id AND m.loop_id=t.id::text
      AND m.kind='message' AND m.role='assistant'
  ) f ON TRUE
  WHERE t.created_at >= ${since} AND t.created_at <= ${until} AND COALESCE(t.run_config->>'kind','chat')='chat'
  WINDOW next_turn AS (PARTITION BY t.conversation_id ORDER BY t.created_at,t.id)
  UNION ALL
  SELECT r.id::text, 'background', r.task, CASE WHEN r.status='ok' THEN 'completed' ELSE 'failed' END,
    r.created_at, r.user_id, r.conversation_id, r.turn_id, r.workflow_run_id, r.trace_id,
    r.model_profile_id,r.provider_model,r.app_id,r.total_tokens::double precision,r.credits_used,r.duration_ms::double precision,
    r.error_code,r.error,r.attempts,0,0,0,NULL::double precision,0
  FROM ai.structured_runs r WHERE r.created_at >= ${since} AND r.created_at <= ${until}
  UNION ALL
  SELECT tool.id::text,'tool',tool.tool_name,tool.status,tool.created_at,c.created_by_user_id,
    c.id,tool.turn_id,NULL::uuid,NULL::text,t.model_profile_id,t.provider_model,c.launched_by_app_id,
    NULL::double precision,NULL::double precision,
    EXTRACT(EPOCH FROM (tool.completed_at-tool.started_at))*1000,NULL::text,tool.error,NULL::int,0,0,0,NULL::double precision,0
  FROM ai.tool_calls tool JOIN ai.conversations c ON c.id=tool.conversation_id JOIN ai.turns t ON t.id=tool.turn_id
  WHERE tool.created_at >= ${since} AND tool.created_at <= ${until}
`;
const globalFilter = (q: AiUsageQuery) => sql`
  (${q.userId ?? null}::text IS NULL OR (${q.userId === "unassigned"} AND e.user_id IS NULL) OR e.user_id::text=${q.userId ?? null})
  AND (${q.modelProfileId ?? null}::text IS NULL OR e.model_profile_id=${q.modelProfileId ?? null})
  AND (${q.providerModel ?? null}::text IS NULL OR e.provider_model=${q.providerModel ?? null})
  AND (${q.appId ?? null}::text IS NULL OR e.app_id=${q.appId ?? null})
`;
const runFilter = (q: AiUsageQuery) => sql`
  (${q.kind ?? null}::text IS NULL OR e.kind=${q.kind ?? null})
  AND (${q.status ?? null}::text IS NULL OR e.status=${q.status ?? null})
  AND (${q.task ?? null}::text IS NULL OR e.task=${q.task ?? null})
  AND (${q.errorCode ?? null}::text IS NULL OR e.error_code=${q.errorCode ?? null})
  AND (${q.search ?? ""}='' OR position(lower(${q.search ?? ""}) in lower(concat_ws(' ',e.task,e.error_code,e.error)))>0)
`;
const stats = sql`
  count(*)::int AS runs, count(*) FILTER (WHERE status='failed')::int AS failed,
  sum(tokens)::double precision AS tokens, sum(credits)::double precision AS credits,
  COALESCE(count(tokens)::double precision/NULLIF(count(*),0),0) AS "tokenCoverage",
  COALESCE(count(credits)::double precision/NULLIF(count(*),0),0) AS "creditsCoverage",
  avg(duration_ms)::double precision AS "avgDurationMs",
  avg(speed)::double precision AS "avgOutputTokensPerSecond", COALESCE(sum(switches),0)::int AS "switchesAway",
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS "p95DurationMs",
  COALESCE(sum(assistant_messages),0)::int AS "assistantMessages",
  COALESCE(sum(positive),0)::int AS positive,COALESCE(sum(negative),0)::int AS negative,
  COALESCE(sum(positive+negative),0)::int AS rated
`;
const comparisonOrder = (q: AiUsageQuery) => {
  switch (q.sort) {
    case "tokens":
      return sql`tokens DESC NULLS LAST`;
    case "credits":
      return sql`credits DESC NULLS LAST`;
    case "errors":
      return sql`failed DESC`;
    case "negative":
      return sql`negative DESC`;
    case "negativeRate":
      return sql`negative::double precision/NULLIF(rated,0) DESC NULLS LAST, rated DESC`;
    default:
      return sql`runs DESC`;
  }
};
const pageOf = async <T>(projection: ReturnType<typeof events>, q: AiUsageQuery): Promise<AiUsagePage<T>> => {
  const [count] = await sql<{ total: number }[]>`WITH rows AS (${projection}) SELECT count(*)::int AS total FROM rows`;
  const total = count?.total ?? 0;
  const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.perPage)));
  const items = await sql<T[]>`${projection} LIMIT ${q.perPage} OFFSET ${(page - 1) * q.perPage}`;
  return { items, total, page, perPage: q.perPage };
};
const runColumns = sql`e.id, e.kind, e.task, e.status, e.created_at::text AS "createdAt", e.user_id::text AS "userId",
  COALESCE(NULLIF(u.display_name,''),u.uid) AS "userLabel",e.model_profile_id AS "modelProfileId",e.provider_model AS "providerModel",
  e.app_id AS "appId",e.conversation_id::text AS "conversationId",e.turn_id::text AS "turnId",e.workflow_run_id::text AS "workflowRunId",
  e.trace_id AS "traceId",e.tokens,e.credits,e.duration_ms AS "durationMs",e.error_code AS "errorCode",e.error,e.attempts`;

export const aiUsage = {
  report: async (range = "30d", options: AiUsageReportOptions = {}): Promise<AiUsageReport> => {
    const { query: q, since, until } = period({ ...options, range: AiUsageQuerySchema.shape.range.parse(range) });
    const source = events(since, until);
    const filtered = sql`SELECT e.* FROM (${source}) e WHERE ${globalFilter(q)}`;
    const inference = sql`SELECT * FROM (${filtered}) i WHERE kind<>'tool'`;
    const summary = async (kind?: string) => {
      const [row] = await sql<AiUsageStats[]>`SELECT ${stats} FROM (${filtered}) e WHERE ${kind ? sql`kind=${kind}` : sql`kind<>'tool'`}`;
      return row!;
    };
    const groups = (dimension: "users" | "models" | "tasks" | "apps" | "capabilities") => {
      const key =
        dimension === "users"
          ? sql`e.user_id::text`
          : dimension === "models"
            ? sql`e.model_profile_id`
            : dimension === "tasks" || dimension === "capabilities"
              ? sql`e.task`
              : sql`e.app_id`;
      const label = dimension === "users" ? sql`COALESCE(NULLIF(u.display_name,''),u.uid)` : key;
      const provider = dimension === "models" ? sql`e.provider_model` : sql`NULL::text`;
      return pageOf<AiUsageGroup>(
        sql`WITH grouped AS (
        SELECT ${key} AS id,${label} AS label,${provider} AS "providerModel",${stats}
        FROM (${dimension === "capabilities" ? sql`SELECT * FROM (${filtered}) e WHERE kind='tool'` : inference}) e LEFT JOIN auth.users u ON u.id=e.user_id
        GROUP BY ${key},${label},${provider}
      ) SELECT grouped.*,${dimension === "users" ? sql`(SELECT count(DISTINCT task)::int FROM (${filtered}) e WHERE kind='tool' AND e.user_id::text=grouped.id)` : sql`0::int`} AS capabilities FROM grouped ORDER BY ${comparisonOrder(q)},id NULLS LAST,"providerModel" NULLS LAST`,
        q,
      );
    };
    const runRows = sql`SELECT ${runColumns} FROM (${filtered}) e LEFT JOIN auth.users u ON u.id=e.user_id
      WHERE ${runFilter(q)} ORDER BY e.created_at DESC,e.kind,e.id`;
    // The response period is authoritative for both summary and feedback. Editing a rating never moves its response into a different period.
    const feedbackRows = sql`SELECT m.id::text AS id,c.id::text AS "conversationId",c.title AS "conversationTitle",
      e.user_id::text AS "userId",COALESCE(NULLIF(u.display_name,''),u.uid) AS "userLabel",
      e.model_profile_id AS "modelProfileId",e.provider_model AS "providerModel",
      CASE WHEN m.feedback_rating=1 THEN 'up' ELSE 'down' END AS rating,
      m.feedback_reasons AS reasons,m.feedback_comment AS comment,m.created_at::text AS "createdAt",m.feedback_updated_at::text AS "updatedAt"
      FROM (${filtered}) e JOIN ai.messages m ON m.loop_id=e.id AND m.conversation_id=e.conversation_id
      JOIN ai.conversations c ON c.id=e.conversation_id LEFT JOIN auth.users u ON u.id=e.user_id
      WHERE e.kind='chat' AND m.kind='message' AND m.role='assistant' AND m.feedback_rating IN (1,-1)
      AND (${q.rating ?? null}::text IS NULL OR m.feedback_rating=${q.rating === "up" ? 1 : -1})
      AND (${q.reason ?? null}::text IS NULL OR ${q.reason ?? null}=ANY(m.feedback_reasons))
      ORDER BY m.created_at DESC,m.id`;
    const [overview, chat, background, tool, users, models, tasks, apps, feedback, runs, timeline, unassigned, capabilities, launches] =
      await Promise.all([
        summary(),
        summary("chat"),
        summary("background"),
        summary("tool"),
        groups("users"),
        groups("models"),
        groups("tasks"),
        groups("apps"),
        pageOf<AiUsageFeedback>(feedbackRows, q),
        pageOf<AiUsageRun>(runRows, q),
        sql<
          AiUsagePoint[]
        >`SELECT date_trunc(${q.range === "24h" ? "hour" : "day"},created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
        count(*)::int AS turns,sum(tokens)::double precision AS tokens,count(*) FILTER (WHERE status='failed')::int AS failed,sum(credits)::double precision AS credits
        FROM (${inference}) e GROUP BY 1 ORDER BY 1`,
        sql<{ count: number }[]>`SELECT count(*)::int AS count FROM (${source}) e WHERE e.kind='background' AND e.user_id IS NULL
        AND ${globalFilter({ ...q, userId: undefined })}`,
        groups("capabilities"),
        pageOf<AiUsageLaunch>(
          sql`SELECT c.launched_by_app_id AS "appId",count(*)::int AS chats,count(DISTINCT c.created_by_user_id)::int AS users
        FROM ai.conversations c WHERE c.created_at >= ${since} AND c.created_at <= ${until} AND c.launched_by_app_id IS NOT NULL
        AND (${q.userId ?? null}::text IS NULL OR (${q.userId === "unassigned"} AND c.created_by_user_id IS NULL) OR c.created_by_user_id::text=${q.userId ?? null})
        AND (${q.appId ?? null}::text IS NULL OR c.launched_by_app_id=${q.appId ?? null})
        AND ((${q.modelProfileId ?? null}::text IS NULL AND ${q.providerModel ?? null}::text IS NULL) OR EXISTS (
          SELECT 1 FROM (${filtered}) e WHERE e.kind='chat' AND e.conversation_id=c.id
        )) GROUP BY c.launched_by_app_id ORDER BY chats DESC,c.launched_by_app_id`,
          q,
        ),
      ]);
    const step = q.range === "24h" ? 3600000 : 86400000;
    const points = new Map(timeline.map((p) => [new Date(p.bucket).toISOString(), p]));
    const filled: AiUsagePoint[] = [];
    for (let time = Math.floor(since.getTime() / step) * step; time <= until.getTime(); time += step) {
      const bucket = new Date(time).toISOString();
      filled.push({ ...(points.get(bucket) ?? { turns: 0, tokens: 0, failed: 0, credits: 0 }), bucket });
    }
    return {
      query: q,
      since: since.toISOString(),
      until: until.toISOString(),
      overview,
      chat,
      background,
      tool,
      unassignedBackgroundRuns: unassigned[0]?.count ?? 0,
      timeline: filled,
      users,
      models,
      tasks,
      apps,
      feedback,
      runs,
      capabilities,
      launches,
    };
  },
  /** Resolve one metadata record only; this never opens another user's chat content. */
  detail: async (kind: AiUsageRun["kind"], id: string): Promise<AiUsageRun | null> => {
    const [row] = await sql<AiUsageRun[]>`SELECT ${runColumns} FROM (${events(new Date(0), new Date())}) e
      LEFT JOIN auth.users u ON u.id=e.user_id WHERE e.kind=${kind} AND e.id=${id}`;
    return row ?? null;
  },
  facets: async (field: "userId" | "modelProfileId" | "providerModel" | "appId" | "task", search: string, input: Partial<AiUsageQuery>) => {
    const { query, since, until } = period(input);
    const key =
      field === "userId"
        ? sql`e.user_id::text`
        : field === "modelProfileId"
          ? sql`e.model_profile_id`
          : field === "providerModel"
            ? sql`e.provider_model`
            : field === "appId"
              ? sql`e.app_id`
              : sql`e.task`;
    const label = field === "userId" ? sql`COALESCE(NULLIF(u.display_name,''),u.uid,e.user_id::text)` : key;
    return sql<{ id: string; label: string }[]>`SELECT DISTINCT ${key} AS id,${label} AS label FROM (${events(since, until)}) e
      LEFT JOIN auth.users u ON u.id=e.user_id WHERE ${key} IS NOT NULL
      AND (position(lower(${search}) in lower(${label}))>0 OR ${key}=${search} OR (${field === "userId"} AND position(lower(${search}) in lower(COALESCE(u.uid,'')))>0))
      ORDER BY label,id LIMIT ${query.perPage}`;
  },
};
