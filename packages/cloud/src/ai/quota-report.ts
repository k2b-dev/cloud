import type { SQL } from "bun";
import { sql } from "../runtime/clients";

import { resolveDisplayNames } from "../server/services/access-display";
import { recursiveGroupIdsSubquery } from "../services/accounts/group-sql";
import { toPgTextArray } from "../services/postgres";
import { hasBillableAiPricing } from "../shared/ai-costs";
import { type AiQuotaReport, type AiQuotaReportQuery, AiQuotaReportQuerySchema } from "../shared/ai-quotas";
import { aiPeopleAtLimit } from "./quota-limits";
import { aiQuotas } from "./quotas";
import { readAiSettingsState } from "./settings";

/** Resolve display metadata only for administration, never on the inference path. */
export async function quotaAdminConfig() {
  const config = await aiQuotas.config();
  const limits = await aiPeopleAtLimit();
  const grants = await resolveDisplayNames(config.rules.flatMap((rule) => rule.grants));
  let offset = 0;
  return {
    ...config,
    rules: config.rules.map((rule) => ({
      ...rule,
      peopleAtLimit: limits.find((limit) => limit.scope === rule.scope)?.people.length ?? 0,
      grants: rule.grants.map(() => {
        const grant = grants[offset++]!;
        return {
          principal: grant.principal,
          limit: grant.limit,
          displayName: grant.displayName,
          serviceAccountKind: grant.serviceAccountKind,
        };
      }),
    })),
  };
}

const reportPeriod = (input: Partial<AiQuotaReportQuery>, now: Date) => {
  const query = AiQuotaReportQuerySchema.parse(input);
  const until = new Date(Math.min(Date.parse(query.until ?? now.toISOString()), now.getTime()));
  const days = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 }[query.range];
  return { query, until, since: new Date(until.getTime() - days * 86400000) };
};

type ReportStatement = { query: AiQuotaReport["query"]; now: Date; since: Date; until: Date; pricedModels: string[] };

/**
 * The report's one statement. It reads calls only from the earliest moment the report shows: the start of the period
 * or of the oldest current rule period, whichever is earlier. The last use of each account is one index lookup per
 * account, so no read grows with the history of calls.
 */
const reportStatement = (db: typeof sql, { query, now, since, until, pricedModels }: ReportStatement) => {
  const bucket = query.range === "24h" ? "hour" : "day";
  const order = query.sort === "label" ? db`label` : query.sort === "cost" ? db`cost` : db`last_used`;
  const direction = query.direction === "asc" ? db`ASC` : db`DESC`;
  // A latest chat call is one backward step on the account's (id, started_at) index, which `max` makes the planner take;
  // an EXISTS lets it scan the whole call table for an account without chat calls.
  const lastChat = (identity: SQL.Query<unknown>, bounded: boolean) =>
    db`(SELECT max(c.started_at) FROM ai.inference_calls c WHERE ${identity} AND c.kind='chat'
      ${bounded ? db`AND c.started_at<=${now} AND (${query.model}='' OR c.model_id=${query.model})` : db``})`;
  // num_nulls keeps the planner off the user index for "no user", which holds every background call.
  const lastUsed = (type: "user" | "service_account") =>
    lastChat(type === "user" ? db`c.user_id=a.id` : db`c.service_account_id=a.id AND num_nulls(c.user_id)=1`, true);
  return db<Omit<AiQuotaReport, "query" | "since" | "until" | "asOf">[]>`
    WITH config AS MATERIALIZED (SELECT enabled,rules FROM ai.cost_config WHERE singleton),
    rules AS MATERIALIZED (
      SELECT r->>'scope' AS scope,r->'grants' AS grants,
        (r->>'anchor')::timestamptz + floor(extract(epoch FROM (${now}::timestamptz-(r->>'anchor')::timestamptz)) / ((r->>'hours')::int*3600)) * ((r->>'hours')::int*interval '1 hour') AS starts
      FROM config,jsonb_array_elements(rules) r WHERE (${query.model}='' OR (r->>'scope' IN ('*',${query.model}) AND ${query.model}=ANY(${toPgTextArray(pricedModels)}::text[]))) AND (r->>'scope'='*' OR r->>'scope'=ANY(${toPgTextArray(pricedModels)}::text[]))
    ), bound AS MATERIALIZED (
      SELECT least(${since}::timestamptz,(SELECT min(starts) FROM rules)) AS since
    ), accounts AS (
      SELECT 'user'::text AS type,u.id,COALESCE(NULLIF(u.display_name,''),u.uid) AS label,u.id AS user_id,NULL::uuid AS service_id
      FROM auth.users u WHERE ${query.search}<>'' OR ${lastChat(db`c.user_id=u.id`, false)} IS NOT NULL
        OR EXISTS(SELECT 1 FROM ai.conversations c JOIN ai.turns t ON t.conversation_id=c.id WHERE c.created_by_user_id=u.id AND t.run_config->>'assistantChat'='true' AND t.run_config->'mandate' IS NULL)
      UNION ALL SELECT 'service_account',id,name,NULL::uuid,id FROM auth.service_accounts s
      WHERE ${query.search}<>'' OR ${lastChat(db`c.service_account_id=s.id`, false)} IS NOT NULL
    ), identities AS MATERIALIZED (
      SELECT a.*,ARRAY(SELECT group_id FROM (${recursiveGroupIdsSubquery(db`a.user_id`)}) groups) AS groups
      FROM accounts a WHERE position(lower(${query.search}) in lower(label))>0 OR id::text=${query.search}
    ), calls AS MATERIALIZED (
      SELECT c.*,COALESCE(c.user_id,c.service_account_id) AS identity_id,
        CASE WHEN c.user_id IS NOT NULL THEN 'user' ELSE 'service_account' END AS identity_type,
        (COALESCE((c.pricing->>'inputPerMillion')::numeric,0)>0 OR COALESCE((c.pricing->>'outputPerMillion')::numeric,0)>0) AND c.cost IS NULL AND (c.finished_at IS NOT NULL OR (c.lease_expires_at<=${now} OR (c.turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai.turns t WHERE t.id=c.turn_id AND t.attempt=c.turn_attempt AND t.status='running' AND t.lease_expires_at>${now})))) AS unknown
      FROM ai.inference_calls c WHERE c.kind='chat' AND c.started_at<=${now} AND c.started_at>=(SELECT since FROM bound)
    ), periods AS MATERIALIZED (
      SELECT * FROM calls WHERE started_at>=${since} AND started_at<${until}
        AND (${query.model}='' OR model_id=${query.model})
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
      SELECT a.*,COALESCE(sum(c.cost),0)::float8 AS used,count(c.id) FILTER(WHERE c.unknown)::int AS unknown
      FROM allowances a LEFT JOIN calls c ON c.identity_id=a.id AND c.identity_type=a.type
        AND (a.scope='*' OR c.model_id=a.scope) AND c.started_at>=a.starts
        AND c.started_at>COALESCE((SELECT max(created_at) FROM ai.cost_resets z
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
        CASE WHEN a.type='user' THEN ${lastUsed("user")} ELSE ${lastUsed("service_account")} END AS last_used,
        sum(p.cost)::float8 AS cost,COALESCE(sum(p.input),0)::float8 AS input,COALESCE(sum(p.output),0)::float8 AS output,
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
      SELECT id,type,label,cost,input,output,calls,measured,estimated,unknown,status,scopes,exhausted,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',b.scope,'limit',b.amount,'used',b.used,'unknown',b.unknown,
          'bypassed', NOT COALESCE((SELECT enabled FROM config),false) OR (b.scope<>'*' AND EXISTS(SELECT 1 FROM balances w WHERE w.id=b.id AND w.type=b.type AND w.scope='*' AND w.amount IS NULL))) ORDER BY b.scope)
          FROM balances b WHERE b.id=cohort.id AND b.type=cohort.type),'[]') AS balances,
        to_char(last_used AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastUsed"
      FROM cohort ORDER BY ${order} ${direction} NULLS LAST,id,type LIMIT 25 OFFSET ((SELECT page FROM pagination)-1)*25
    ), timeline AS (
      SELECT date_trunc(${bucket},started_at AT TIME ZONE 'UTC') AS bucket,
        sum(cost)::float8 AS cost,COALESCE(sum(input),0)::float8 AS input,COALESCE(sum(output),0)::float8 AS output,count(*)::int AS calls,count(*) FILTER(WHERE input IS NOT NULL AND output IS NOT NULL)::int AS measured,count(*) FILTER(WHERE unknown)::int AS unknown
      FROM selected_calls GROUP BY 1 ORDER BY 1
    ), models AS (
      SELECT model_profile_id AS model,sum(cost)::float8 AS cost,COALESCE(sum(input),0)::float8 AS input,COALESCE(sum(output),0)::float8 AS output,
        count(*)::int AS calls,count(*) FILTER(WHERE input IS NOT NULL AND output IS NOT NULL)::int AS measured,count(*) FILTER(WHERE unknown)::int AS unknown
      FROM selected_calls GROUP BY 1 ORDER BY sum(cost) DESC NULLS LAST,model_profile_id LIMIT 20
    ) SELECT pagination.*,
      (SELECT jsonb_build_object('cost',sum(cost),'accounts',count(*) FILTER(WHERE calls>0),'input',COALESCE(sum(input),0),'output',COALESCE(sum(output),0),
        'calls',COALESCE(sum(calls),0),'measured',COALESCE(sum(measured),0),'estimated',COALESCE(sum(estimated),0),'unknown',COALESCE(sum(unknown),0)) FROM cohort) AS overview,
      (SELECT jsonb_build_object('id',id,'type',type,'label',label,'lastUsed',NULL) FROM accounts WHERE id=${query.identity ?? null}::uuid AND type=${query.identityType}) AS selected,
      COALESCE((SELECT jsonb_agg(page_rows) FROM page_rows),'[]') AS items,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('cost',cost,'at',to_char(bucket,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'input',input,'output',output,'calls',calls,'measured',measured,'unknown',unknown)) FROM timeline),'[]') AS timeline,
      COALESCE((SELECT jsonb_agg(models) FROM models),'[]') AS models FROM pagination`;
};

const pricedModelIds = async () =>
  (await readAiSettingsState()).profiles.filter((p) => hasBillableAiPricing(p.pricing)).map((p) => p.modelId);

/** JSON grant cardinality is unknown to the planner; JIT compilation otherwise dominates small admin reports. */
const withoutJit = <T>(run: (db: typeof sql) => Promise<T>) =>
  sql.begin(async (db) => {
    // Scoped to this read transaction.
    await db`SET LOCAL jit = off`;
    return run(db);
  });

/** The plan PostgreSQL runs for the report's statement (`EXPLAIN (ANALYZE, FORMAT JSON)`), for tests that hold its reads. */
export async function explainQuotaReport(input: Partial<AiQuotaReportQuery> = {}, now = new Date()): Promise<unknown> {
  const { query, since, until } = reportPeriod(input, now);
  const pricedModels = await pricedModelIds();
  const [row] = await withoutJit(
    (db) =>
      db<{ "QUERY PLAN": unknown }[]>`EXPLAIN (ANALYZE, FORMAT JSON) ${reportStatement(db, { query, now, since, until, pricedModels })}`,
  );
  return row?.["QUERY PLAN"];
}

/** One database snapshot: aggregate and filter the cohort before paginating identities. */
export async function quotaReport(input: Partial<AiQuotaReportQuery> = {}, now = new Date()): Promise<AiQuotaReport> {
  const { query, since, until } = reportPeriod(input, now);
  if (query.view === "rules")
    return {
      query,
      since: since.toISOString(),
      until: until.toISOString(),
      asOf: now.toISOString(),
      overview: { cost: null, accounts: 0, input: 0, output: 0, calls: 0, measured: 0, estimated: 0, unknown: 0 },
      timeline: [],
      models: [],
      items: [],
      selected: null,
      total: 0,
      page: 1,
      perPage: 25,
    };
  const pricedModels = await pricedModelIds();
  const [data] = await withoutJit((db) => reportStatement(db, { query, now, since, until, pricedModels }));
  if (!data) throw new Error("Quota report returned no snapshot");
  return {
    ...data,
    query: { ...query, until: until.toISOString(), page: data.page },
    since: since.toISOString(),
    until: until.toISOString(),
    asOf: now.toISOString(),
  };
}
