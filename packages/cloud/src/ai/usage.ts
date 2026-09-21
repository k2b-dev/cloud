import { sql } from "bun";
import { type AiUsageQuery, AiUsageQuerySchema } from "../shared/ai-usage";
import { aiQuotas } from "./quotas";

export { AI_USAGE_RANGES, type AiUsageRange } from "../shared/ai-usage";

export type AiUsageRun = {
  id: string;
  kind: "chat" | "background";
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
  workflowId: string | null;
  workflowName: string | null;
  estimated: boolean;
  traceId: string | null;
  tokens: number | null;
  cost: number | null;
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
  cost: number | null;
  tokenCoverage: number;
  costCoverage: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  avgOutputTokensPerSecond: number | null;
  switchesAway: number;
  assistantMessages: number;
  positive: number;
  negative: number;
  rated: number;
};
export type AiUsageGroup = AiUsageStats & { id: string | null; label: string | null; providerModel?: string | null; appId?: string | null };
export type AiUsagePoint = { bucket: string; turns: number; tokens: number | null; failed: number; cost: number | null };
export type AiUsagePagination = { page: number; perPage: number; total: number };
export type AiUsagePage<T> = AiUsagePagination & { items: T[] };
export type AiUsageReport = {
  query: AiUsageQuery;
  since: string;
  until: string;
  overview: AiUsageStats;
  chat: AiUsageStats;
  background: AiUsageStats;
  unassignedBackgroundRuns: number;
  timeline: AiUsagePoint[];
  users: AiUsagePage<AiUsageGroup>;
  models: AiUsagePage<AiUsageGroup>;
  launches: AiUsagePage<AiUsageLaunch>;
  tasks: AiUsagePage<AiUsageGroup>;
  workflows: AiUsagePage<AiUsageGroup>;
  unit: string;
  apps: AiUsagePage<AiUsageGroup>;
  feedback: AiUsagePage<AiUsageFeedback>;
  runs: AiUsagePage<AiUsageRun>;
};
export type AiUsageReportOptions = Partial<AiUsageQuery>;
// Aggregate rows share the same coverage and feedback definitions across dimensions.
export type AiUsageOverview = AiUsageStats;
export type AiUsageModel = AiUsageGroup;
export type AiUsageUser = AiUsageGroup;
export type AiUsageBackgroundTask = AiUsageGroup;
export type AiUsageLaunch = { appId: string; chats: number; users: number };

const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const period = (input: Partial<AiUsageQuery>) => {
  const query = AiUsageQuerySchema.parse(input);
  const until = query.until ? new Date(query.until) : new Date();
  const since = new Date(until.getTime() - days[query.range] * 86400000);
  return { query: { ...query, until: until.toISOString() }, since, until };
};

/**
 * One row per durable inference event. Capability calls are not inference and
 * are recorded by the platform in `capabilities.executions`; this projection
 * never carries message content.
 */
const events = (since: Date, until: Date) => sql`
  SELECT c.id::text,c.kind,c.task,CASE WHEN c.status='ok' THEN 'completed' WHEN c.status='running' AND c.lease_expires_at<=now() THEN 'failed' ELSE c.status END AS status,
    c.started_at AS created_at,COALESCE(c.user_id,c.service_account_id) AS user_id,c.conversation_id,c.turn_id,c.workflow_run_id,c.trace_id,
    c.model_profile_id,c.provider_model,c.app_id,(c.input+c.output)::float8 AS tokens,c.cost AS cost,
    extract(epoch FROM (c.finished_at-c.started_at))*1000 AS duration_ms,c.error_code,NULL::text AS error,1 AS attempts,
    CASE WHEN c.id=first_call.id THEN f.messages ELSE 0 END AS assistant_messages,
    CASE WHEN c.id=first_call.id THEN f.positive ELSE 0 END AS positive,
    CASE WHEN c.id=first_call.id THEN f.negative ELSE 0 END AS negative,
    c.output/NULLIF(extract(epoch FROM(c.finished_at-c.started_at)),0) AS speed,CASE WHEN c.id=first_call.id AND EXISTS (
      SELECT 1 FROM ai.turns t JOIN LATERAL (SELECT model_profile_id FROM ai.turns next
        WHERE next.conversation_id=t.conversation_id AND (next.created_at,next.id)>(t.created_at,t.id)
        ORDER BY next.created_at,next.id LIMIT 1) next ON true
      WHERE t.id=c.turn_id AND next.model_profile_id IS DISTINCT FROM c.model_profile_id
    ) THEN 1 ELSE 0 END AS switches,
    c.id=first_call.id AS first_in_turn,c.estimated,c.workflow_id,c.workflow_name
  FROM ai.inference_calls c
  LEFT JOIN LATERAL (SELECT id FROM ai.inference_calls first WHERE first.turn_id=c.turn_id AND first.kind='chat' ORDER BY started_at,id LIMIT 1) first_call ON c.kind='chat'
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS messages,count(*) FILTER(WHERE feedback_rating=1)::int AS positive,count(*) FILTER(WHERE feedback_rating=-1)::int AS negative
    FROM ai.messages m WHERE m.loop_id=c.turn_id::text AND m.conversation_id=c.conversation_id AND m.kind='message' AND m.role='assistant'
  ) f ON c.kind='chat'
  WHERE c.started_at>=${since} AND c.started_at<=${until}
`;
const globalFilter = (q: AiUsageQuery) => sql`
  (${q.userId ?? null}::text IS NULL OR (${q.userId === "unassigned"} AND e.user_id IS NULL) OR e.user_id::text=${q.userId ?? null})
  AND (${q.modelProfileId ?? null}::text IS NULL OR e.model_profile_id=${q.modelProfileId ?? null})
  AND (${q.providerModel ?? null}::text IS NULL OR e.provider_model=${q.providerModel ?? null})
  AND (${q.workflowId ?? null}::uuid IS NULL OR e.workflow_id=${q.workflowId ?? null}::uuid)
  AND (${q.workflowRunId ?? null}::uuid IS NULL OR e.workflow_run_id=${q.workflowRunId ?? null}::uuid)
  AND (${q.appId ?? null}::text IS NULL OR e.app_id=${q.appId ?? null})
`;
const runFilter = (q: AiUsageQuery) => sql`
  (${q.kind ?? null}::text IS NULL OR e.kind=${q.kind ?? null})
  AND (${q.status ?? null}::text IS NULL OR e.status=${q.status ?? null})
  AND (${q.task ?? null}::text IS NULL OR e.task=${q.task ?? null})
  AND (${q.errorCode ?? null}::text IS NULL OR e.error_code=${q.errorCode ?? null})
  AND (${q.search ?? ""}='' OR position(lower(${q.search ?? ""}) in lower(concat_ws(' ',e.task,e.error_code,e.error)))>0)
`;
const stats = () => sql`
  count(*)::int AS runs, count(*) FILTER (WHERE e.status='failed')::int AS failed,
  sum(e.tokens)::double precision AS tokens, sum(e.cost)::double precision AS cost,
  COALESCE(count(e.tokens)::double precision/NULLIF(count(*),0),0) AS "tokenCoverage",
  COALESCE(count(e.cost)::double precision/NULLIF(count(*),0),0) AS "costCoverage",
  avg(e.duration_ms)::double precision AS "avgDurationMs",
  avg(e.speed)::double precision AS "avgOutputTokensPerSecond", COALESCE(sum(e.switches),0)::int AS "switchesAway",
  percentile_cont(0.95) WITHIN GROUP (ORDER BY e.duration_ms) AS "p95DurationMs",
  COALESCE(sum(e.assistant_messages),0)::int AS "assistantMessages",
  COALESCE(sum(e.positive),0)::int AS positive,COALESCE(sum(e.negative),0)::int AS negative,
  COALESCE(sum(e.positive+e.negative),0)::int AS rated
`;
const comparisonOrder = (q: AiUsageQuery) => {
  const direction = q.direction === "asc" ? sql`ASC` : sql`DESC`;
  switch (q.sort) {
    case "tokens":
      return sql`tokens ${direction} NULLS LAST`;
    case "cost":
      return sql`cost ${direction} NULLS LAST`;
    case "errors":
      return sql`failed ${direction}`;
    case "negative":
      return sql`negative ${direction}`;
    case "negativeRate":
      return sql`negative::double precision/NULLIF(rated,0) ${direction} NULLS LAST, rated ${direction}`;
    default:
      return sql`runs ${direction}`;
  }
};
const pageOf = async <T>(projection: ReturnType<typeof events>, q: AiUsageQuery): Promise<AiUsagePage<T>> => {
  const [count] = await sql<{ total: number }[]>`WITH rows AS (${projection}) SELECT count(*)::int AS total FROM rows`;
  const total = count?.total ?? 0;
  const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.perPage)));
  const items = await sql<T[]>`${projection} LIMIT ${q.perPage} OFFSET ${(page - 1) * q.perPage}`;
  return { items, total, page, perPage: q.perPage };
};
const runColumns = () => sql`e.id, e.kind, e.task, e.status, e.created_at::text AS "createdAt", e.user_id::text AS "userId",
  COALESCE(NULLIF(u.display_name,''),u.uid,sa.name) AS "userLabel",e.model_profile_id AS "modelProfileId",e.provider_model AS "providerModel",
  e.app_id AS "appId",e.conversation_id::text AS "conversationId",e.turn_id::text AS "turnId",e.workflow_run_id::text AS "workflowRunId",
  e.workflow_id::text AS "workflowId",e.workflow_name AS "workflowName",e.estimated,e.trace_id AS "traceId",e.tokens,e.cost::float8 AS cost,e.duration_ms AS "durationMs",e.error_code AS "errorCode",e.error,e.attempts`;

export const aiUsage = {
  report: async (range = "30d", options: AiUsageReportOptions = {}): Promise<AiUsageReport> => {
    const { query: q, since, until } = period({ ...options, range: AiUsageQuerySchema.shape.range.parse(range) });
    const source = events(since, until);
    const filtered = sql`SELECT e.* FROM (${source}) e WHERE ${globalFilter(q)}`;
    const inference = filtered;
    const summary = async (kind?: string) => {
      const [row] = await sql<AiUsageStats[]>`SELECT ${stats()} FROM (${filtered}) e WHERE ${kind ? sql`kind=${kind}` : sql`TRUE`}`;
      return row!;
    };
    const groups = (dimension: "users" | "models" | "tasks" | "apps" | "workflows") => {
      const key =
        dimension === "workflows"
          ? sql`e.workflow_id::text`
          : dimension === "users"
            ? sql`e.user_id::text`
            : dimension === "models"
              ? sql`e.model_profile_id`
              : dimension === "tasks"
                ? sql`e.task`
                : sql`e.app_id`;
      const label =
        dimension === "workflows"
          ? sql`(array_agg(e.workflow_name ORDER BY e.created_at DESC,e.id DESC))[1]`
          : dimension === "users"
            ? sql`COALESCE(NULLIF(u.display_name,''),u.uid,sa.name)`
            : key;
      const provider = dimension === "models" ? sql`e.provider_model` : sql`NULL::text`;
      return pageOf<AiUsageGroup>(
        sql`SELECT ${key} AS id,${label} AS label,${provider} AS "providerModel",${dimension === "workflows" ? sql`min(e.app_id)` : sql`NULL::text`} AS "appId",${stats()}
        FROM (${inference}) e LEFT JOIN auth.users u ON u.id=e.user_id LEFT JOIN auth.service_accounts sa ON sa.id=e.user_id
        WHERE ${dimension === "workflows" ? sql`e.workflow_id IS NOT NULL` : sql`TRUE`}
        GROUP BY ${key},${dimension === "workflows" ? key : label},${provider}
        ORDER BY ${comparisonOrder(q)},id NULLS LAST,"providerModel" NULLS LAST`,
        q,
      );
    };
    const runRows = sql`SELECT ${runColumns()} FROM (${filtered}) e LEFT JOIN auth.users u ON u.id=e.user_id LEFT JOIN auth.service_accounts sa ON sa.id=e.user_id
      WHERE ${runFilter(q)} ORDER BY e.created_at DESC,e.kind,e.id`;
    // The response period is authoritative for both summary and feedback. Editing a rating never moves its response into a different period.
    const feedbackRows = sql`SELECT m.id::text AS id,c.id::text AS "conversationId",c.title AS "conversationTitle",
      e.user_id::text AS "userId",COALESCE(NULLIF(u.display_name,''),u.uid,sa.name) AS "userLabel",
      e.model_profile_id AS "modelProfileId",e.provider_model AS "providerModel",
      CASE WHEN m.feedback_rating=1 THEN 'up' ELSE 'down' END AS rating,
      m.feedback_reasons AS reasons,m.feedback_comment AS comment,m.created_at::text AS "createdAt",m.feedback_updated_at::text AS "updatedAt"
      FROM (${filtered}) e JOIN ai.messages m ON m.loop_id=e.turn_id::text AND m.conversation_id=e.conversation_id
      JOIN ai.conversations c ON c.id=e.conversation_id LEFT JOIN auth.users u ON u.id=e.user_id LEFT JOIN auth.service_accounts sa ON sa.id=e.user_id
      WHERE e.kind='chat' AND e.first_in_turn AND m.kind='message' AND m.role='assistant' AND m.feedback_rating IN (1,-1)
      AND (${q.rating ?? null}::text IS NULL OR m.feedback_rating=${q.rating === "up" ? 1 : -1})
      AND (${q.reason ?? null}::text IS NULL OR ${q.reason ?? null}=ANY(m.feedback_reasons))
      ORDER BY m.created_at DESC,m.id`;
    const [overview, chat, background, users, models, tasks, apps, feedback, runs, timeline, unassigned, launches] = await Promise.all([
      summary(),
      summary("chat"),
      summary("background"),
      groups("users"),
      groups("models"),
      groups("tasks"),
      groups("apps"),
      pageOf<AiUsageFeedback>(feedbackRows, q),
      pageOf<AiUsageRun>(runRows, q),
      sql<
        AiUsagePoint[]
      >`SELECT date_trunc(${q.range === "24h" ? "hour" : "day"},created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
        count(*)::int AS turns,sum(tokens)::double precision AS tokens,count(*) FILTER (WHERE status='failed')::int AS failed,sum(cost)::double precision AS cost
        FROM (${inference}) e GROUP BY 1 ORDER BY 1`,
      sql<{ count: number }[]>`SELECT count(*)::int AS count FROM (${source}) e WHERE e.kind='background' AND e.user_id IS NULL
        AND ${globalFilter({ ...q, userId: undefined })}`,
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
      filled.push({ ...(points.get(bucket) ?? { turns: 0, tokens: 0, failed: 0, cost: 0 }), bucket });
    }
    return {
      query: q,
      since: since.toISOString(),
      until: until.toISOString(),
      overview,
      chat,
      background,
      unassignedBackgroundRuns: unassigned[0]?.count ?? 0,
      timeline: filled,
      users,
      models,
      tasks,
      workflows: await groups("workflows"),
      unit: (await aiQuotas.config()).unit ?? "EUR",
      apps,
      feedback,
      runs,
      launches,
    };
  },
  /** Resolve one metadata record only; this never opens another user's chat content. */
  detail: async (kind: AiUsageRun["kind"], id: string): Promise<AiUsageRun | null> => {
    const [row] = await sql<AiUsageRun[]>`SELECT ${runColumns()} FROM (${events(new Date(0), new Date())}) e
      LEFT JOIN auth.users u ON u.id=e.user_id LEFT JOIN auth.service_accounts sa ON sa.id=e.user_id WHERE e.kind=${kind} AND e.id=${id}`;
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
    const label = field === "userId" ? sql`COALESCE(NULLIF(u.display_name,''),u.uid,sa.name,e.user_id::text)` : key;
    return sql<{ id: string; label: string }[]>`SELECT DISTINCT ${key} AS id,${label} AS label FROM (${events(since, until)}) e
      LEFT JOIN auth.users u ON u.id=e.user_id LEFT JOIN auth.service_accounts sa ON sa.id=e.user_id WHERE ${key} IS NOT NULL
      AND (position(lower(${search}) in lower(${label}))>0 OR ${key}=${search} OR (${field === "userId"} AND position(lower(${search}) in lower(COALESCE(u.uid,'')))>0))
      ORDER BY label,id LIMIT ${query.perPage}`;
  },
};
