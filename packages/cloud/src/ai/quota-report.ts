import { sql } from "bun";
import { recursiveGroupIdsSubquery } from "../services/accounts/group-sql";
import { AiQuotaReportQuerySchema, type AiQuotaReport, type AiQuotaReportQuery } from "../shared/ai-quotas";
import { resolveDisplayNames } from "../server/services/access";
import { aiQuotas } from "./quotas";

/** Resolve display metadata only for administration, never on the inference path. */
export async function quotaAdminConfig() {
  const config = await aiQuotas.config();
  const grants = await resolveDisplayNames(config.rules.flatMap((rule) => rule.grants));
  let offset = 0;
  return {
    ...config,
    rules: config.rules.map((rule) => ({
      ...rule,
      grants: rule.grants.map(() => {
        const grant = grants[offset++]!;
        return { principal: grant.principal, limit: grant.limit, displayName: grant.displayName };
      }),
    })),
  };
}

/** One database snapshot: aggregate and filter the cohort before paginating identities. */
export async function quotaReport(input: Partial<AiQuotaReportQuery> = {}, now = new Date()): Promise<AiQuotaReport> {
  const query = AiQuotaReportQuerySchema.parse(input);
  const until = new Date(Math.min(Date.parse(query.until ?? now.toISOString()), now.getTime()));
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[query.range];
  const since = new Date(until.getTime() - days * 86400000);
  if (query.view === "rules")
    return {
      query,
      since: since.toISOString(),
      until: until.toISOString(),
      asOf: now.toISOString(),
      overview: { accounts: 0, input: 0, output: 0, calls: 0, measured: 0, estimated: 0, unknown: 0 },
      timeline: [],
      models: [],
      items: [],
      selected: null,
      total: 0,
      page: 1,
      perPage: 25,
    };
  const bucket = query.range === "24h" ? "hour" : "day";
  const order = query.sort === "label" ? sql`label` : query.sort === "tokens" ? sql`input + output` : sql`last_used`;
  const direction = query.direction === "asc" ? sql`ASC` : sql`DESC`;
  // JSON grant cardinality is unknown to the planner; JIT compilation otherwise
  // dominates small admin reports. Scope this setting to this read transaction.
  const [data] = await sql.begin(async (db) => {
    await db`SET LOCAL jit = off`;
    return db<Omit<AiQuotaReport, "query" | "since" | "until" | "asOf">[]>`
    WITH config AS MATERIALIZED (SELECT enabled,rules FROM ai.quota_config WHERE singleton),
    rules AS MATERIALIZED (
      SELECT r->>'scope' AS scope,r->'grants' AS grants,
        (r->>'anchor')::timestamptz + floor(extract(epoch FROM (${now}::timestamptz-(r->>'anchor')::timestamptz)) / ((r->>'hours')::int*3600)) * ((r->>'hours')::int*interval '1 hour') AS starts
      FROM config,jsonb_array_elements(rules) r WHERE ${query.model}='' OR r->>'scope' IN ('*',${query.model})
    ), accounts AS (
      SELECT 'user'::text AS type,u.id,COALESCE(NULLIF(u.display_name,''),u.uid) AS label,u.id AS user_id,NULL::uuid AS service_id
      FROM auth.users u WHERE ${query.search}<>'' OR EXISTS(SELECT 1 FROM ai.quota_calls WHERE user_id=u.id)
        OR EXISTS(SELECT 1 FROM ai.conversations c JOIN ai.turns t ON t.conversation_id=c.id WHERE c.created_by_user_id=u.id AND t.run_config->>'assistantChat'='true' AND t.run_config->'mandate' IS NULL)
      UNION ALL SELECT 'service_account',id,name,NULL::uuid,id FROM auth.service_accounts s
      WHERE ${query.search}<>'' OR EXISTS(SELECT 1 FROM ai.quota_calls WHERE service_account_id=s.id)
    ), identities AS MATERIALIZED (
      SELECT a.*,ARRAY(SELECT group_id FROM (${recursiveGroupIdsSubquery(sql`a.user_id`)}) groups) AS groups
      FROM accounts a WHERE position(lower(${query.search}) in lower(label))>0 OR id::text=${query.search}
    ), calls AS MATERIALIZED (
      SELECT c.*,COALESCE(c.user_id,c.service_account_id) AS identity_id,
        CASE WHEN c.user_id IS NOT NULL THEN 'user' ELSE 'service_account' END AS identity_type,
        (c.input IS NULL OR c.output IS NULL) AND (c.finished_at IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM ai.turns t WHERE t.id=c.turn_id AND t.attempt=c.turn_attempt AND t.status='running' AND t.lease_expires_at>${now}
        )) AS unknown
      FROM ai.quota_calls c WHERE c.started_at<=${now}
    ), periods AS MATERIALIZED (
      SELECT * FROM calls WHERE started_at>=${since} AND started_at<${until}
        AND (${query.model}='' OR model_profile_id=${query.model})
    ), allowances AS MATERIALIZED (
      SELECT a.id,a.type,r.scope,
        CASE WHEN bool_or((g->>'limit') IS NULL) FILTER(WHERE g IS NOT NULL) THEN NULL ELSE COALESCE(max((g->>'limit')::float8),0) END AS amount,
        r.starts
      FROM identities a CROSS JOIN rules r
      LEFT JOIN LATERAL (SELECT g FROM jsonb_array_elements(r.grants) g WHERE
        g->'principal'->>'type'='authenticated'
        OR (g->'principal'->>'userId')::uuid=a.user_id
        OR (g->'principal'->>'serviceAccountId')::uuid=a.service_id
        OR (g->'principal'->>'groupId')::uuid=ANY(a.groups)) grant_match ON true
      GROUP BY a.id,a.type,r.scope,r.starts
    ), balances AS MATERIALIZED (
      SELECT a.*,COALESCE(sum(COALESCE(c.input,0)+COALESCE(c.output,0)),0)::float8 AS used,count(c.id) FILTER(WHERE c.unknown)::int AS unknown
      FROM allowances a LEFT JOIN calls c ON c.identity_id=a.id AND c.identity_type=a.type
        AND (a.scope='*' OR c.model_profile_id=a.scope) AND c.started_at>=a.starts
        AND c.started_at>COALESCE((SELECT max(created_at) FROM ai.quota_resets z
          WHERE COALESCE(z.user_id,z.service_account_id)=a.id AND (z.user_id IS NOT NULL)=(a.type='user') AND z.scope=a.scope),'-infinity'::timestamptz)
      GROUP BY a.id,a.type,a.scope,a.amount,a.starts
    ), states AS MATERIALIZED (
      SELECT id,type,count(*)::int AS scopes,
        count(*) FILTER(WHERE amount IS NOT NULL AND used>=amount)::int AS exhausted,
        CASE WHEN bool_or(scope='*' AND amount IS NULL) THEN 'unlimited'
          WHEN bool_or(amount IS NOT NULL AND unknown>0) THEN 'unknown'
          WHEN bool_or(amount IS NOT NULL AND used>=amount) THEN 'exhausted'
          WHEN bool_or(amount IS NOT NULL) THEN 'available' ELSE 'unlimited' END AS status
      FROM balances GROUP BY id,type
    ), summary AS MATERIALIZED (
      SELECT a.id,a.type,a.label,
        CASE WHEN NOT COALESCE((SELECT enabled FROM config),false) THEN 'disabled' ELSE COALESCE(s.status,'unlimited') END AS status,
        COALESCE(s.scopes,0) AS scopes,CASE WHEN s.status='unlimited' OR NOT COALESCE((SELECT enabled FROM config),false) THEN 0 ELSE COALESCE(s.exhausted,0) END AS exhausted,
        (SELECT max(started_at) FROM calls c WHERE c.identity_id=a.id AND c.identity_type=a.type AND (${query.model}='' OR c.model_profile_id=${query.model})) AS last_used,
        COALESCE(sum(p.input),0)::float8 AS input,COALESCE(sum(p.output),0)::float8 AS output,
        count(p.id)::int AS calls,count(p.id) FILTER(WHERE p.input IS NOT NULL AND p.output IS NOT NULL)::int AS measured,count(p.id) FILTER(WHERE p.estimated)::int AS estimated,count(p.id) FILTER(WHERE p.unknown)::int AS unknown
      FROM identities a LEFT JOIN states s ON s.id=a.id AND s.type=a.type
      LEFT JOIN periods p ON p.identity_id=a.id AND p.identity_type=a.type
      GROUP BY a.id,a.type,a.label,s.status,s.scopes,s.exhausted
    ), cohort AS MATERIALIZED (
      SELECT * FROM summary WHERE ${query.status}='all' OR status=${query.status}
    ), selected_calls AS (
      SELECT p.* FROM periods p JOIN cohort a ON a.id=p.identity_id AND a.type=p.identity_type
    ), pagination AS (
      SELECT count(*)::int AS total,least(${query.page},greatest(1,ceil(count(*)/25.0)))::int AS page,25 AS "perPage" FROM cohort
    ), page_rows AS (
      SELECT id,type,label,input,output,calls,measured,estimated,unknown,status,scopes,exhausted,
        to_char(last_used AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastUsed"
      FROM cohort ORDER BY ${order} ${direction} NULLS LAST,id,type LIMIT 25 OFFSET ((SELECT page FROM pagination)-1)*25
    ), timeline AS (
      SELECT date_trunc(${bucket},started_at AT TIME ZONE 'UTC') AS bucket,
        COALESCE(sum(input),0)::float8 AS input,COALESCE(sum(output),0)::float8 AS output,count(*)::int AS calls,count(*) FILTER(WHERE input IS NOT NULL AND output IS NOT NULL)::int AS measured,count(*) FILTER(WHERE unknown)::int AS unknown
      FROM selected_calls GROUP BY 1 ORDER BY 1
    ), models AS (
      SELECT model_profile_id AS model,COALESCE(sum(input),0)::float8 AS input,COALESCE(sum(output),0)::float8 AS output,
        count(*)::int AS calls,count(*) FILTER(WHERE input IS NOT NULL AND output IS NOT NULL)::int AS measured,count(*) FILTER(WHERE unknown)::int AS unknown
      FROM selected_calls GROUP BY 1 ORDER BY COALESCE(sum(input),0)+COALESCE(sum(output),0) DESC,model_profile_id LIMIT 20
    ) SELECT pagination.*,
      (SELECT jsonb_build_object('accounts',count(*) FILTER(WHERE calls>0),'input',COALESCE(sum(input),0),'output',COALESCE(sum(output),0),
        'calls',COALESCE(sum(calls),0),'measured',COALESCE(sum(measured),0),'estimated',COALESCE(sum(estimated),0),'unknown',COALESCE(sum(unknown),0)) FROM cohort) AS overview,
      (SELECT jsonb_build_object('id',id,'type',type,'label',label,'lastUsed',NULL) FROM accounts WHERE id=${query.identity ?? null}::uuid AND type=${query.identityType}) AS selected,
      COALESCE((SELECT jsonb_agg(page_rows) FROM page_rows),'[]') AS items,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('at',to_char(bucket,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'input',input,'output',output,'calls',calls,'measured',measured,'unknown',unknown)) FROM timeline),'[]') AS timeline,
      COALESCE((SELECT jsonb_agg(models) FROM models),'[]') AS models FROM pagination`;
  });
  if (!data) throw new Error("Quota report returned no snapshot");
  return {
    ...data,
    query: { ...query, until: until.toISOString(), page: data.page },
    since: since.toISOString(),
    until: until.toISOString(),
    asOf: now.toISOString(),
  };
}
