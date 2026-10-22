import type { AccessSubject, RequestActor } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { sql } from "bun";
import { z } from "zod";
import type { Overview, OverviewActivity, OverviewAttention } from "../overview-contracts";
import { pulseStoreConfigured } from "../store/service";
import { accessScopeFor, requireBaseAccess } from "./access-control";
import { readOverviewQueries } from "./overview-queries";
import { resolvePublicId } from "./public-resources";
import { iso, isoNullable } from "./telemetry-values";

const Cursor = z.object({ at: z.string().datetime(), id: z.uuid() });
const Page = z.object({
  attentionLimit: z.number().int().min(1).max(1000),
  attentionOffset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activityLimit: z.number().int().min(1).max(1000),
});
type Input = {
  actor: RequestActor;
  accessSubject: AccessSubject;
  baseId: string;
  signal?: AbortSignal;
  attentionLimit?: number;
  attentionOffset?: number;
  activityLimit?: number;
  activityCursor?: string;
};
type AttentionRow = Omit<OverviewAttention, "lastCheckedAt" | "since" | "newestDataAt"> & {
  since: Date;
  lastCheckedAt: Date | null;
  newestDataAt: Date | null;
};
export const readOverview = async (input: Input): Promise<Result<Overview>> => {
  const scope = accessScopeFor(input.actor, input.accessSubject);
  if (!scope.ok) return scope;
  const baseId = z.uuid().safeParse(input.baseId).success ? input.baseId : await resolvePublicId("bases", input.baseId);
  if (!baseId) return fail(err.notFound("Pulse base"));
  const access = await requireBaseAccess(baseId, scope.data, "read");
  if (!access.ok) return access;
  const page = Page.safeParse({
    attentionLimit: input.attentionLimit ?? 50,
    attentionOffset: input.attentionOffset ?? 0,
    activityLimit: input.activityLimit ?? 20,
  });
  if (!page.success) return fail(err.badInput("Use page sizes from 1 to 1000 and a non-negative offset"));
  let cursor: z.infer<typeof Cursor> | null = null;
  if (input.activityCursor) {
    try {
      cursor = Cursor.parse(JSON.parse(input.activityCursor));
    } catch {
      return fail(err.badInput("Invalid activity cursor"));
    }
  }
  const [base] = await sql<{ short_id: string; name: string; timezone: string; state: string }[]>`
    SELECT b.short_id,b.name,b.timezone,s.state FROM pulse.bases b JOIN pulse.base_stores s ON s.base_id=b.id
    WHERE b.id=${baseId}::uuid AND b.deletion_started_at IS NULL`;
  if (!base) return fail(err.notFound("Pulse base"));
  const configured = await pulseStoreConfigured();
  const numbers = await readOverviewQueries({ ...input, baseId, scope: scope.data, available: configured });
  // SQL may take time. Never return a protected old snapshot after revocation.
  const finalAccess = await requireBaseAccess(baseId, scope.data, "read");
  if (!finalAccess.ok) return finalAccess;
  const [sourceSummary] = await sql<{ total: number; current: number }[]>`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE enabled AND last_data_at IS NOT NULL AND stale_since IS NULL)::int AS current
    FROM pulse.sources WHERE base_id=${baseId}::uuid AND NOT deleted`;
  const attentionSet = sql`WITH attention AS (
    SELECT 'alert:'||r.short_id AS id,'alert'::text AS kind,r.short_id AS reference,r.name,r.state,r.severity,r.since,
      r.last_checked_at AS "lastCheckedAt",r.last_error AS "errorCode",sample.key,sample.value,r.comparison,
      CASE WHEN r.severity='critical' THEN r.critical ELSE r.warn END AS threshold,
      NULL::timestamptz AS "newestDataAt",NULL::int AS "expectEverySeconds",NULL::text AS "expectDailyBy",
      CASE WHEN r.state='firing' AND r.severity='critical' THEN 0 WHEN r.state='firing' THEN 1 WHEN r.state='error' THEN 2 ELSE 3 END AS priority
    FROM pulse.alert_rules r LEFT JOIN LATERAL (
      SELECT key,value FROM pulse.alert_states WHERE rule_id=r.id AND state=r.state AND severity IS NOT DISTINCT FROM r.severity
      ORDER BY key LIMIT 1
    ) sample ON true
    WHERE r.base_id=${baseId}::uuid AND r.state IN ('firing','error','no_data')
    UNION ALL
    SELECT 'source:'||short_id,'source',short_id,name,'stale',NULL,stale_since,NULL,NULL,NULL,NULL,NULL,NULL,last_data_at,
      CASE WHEN kind='metrics' THEN scrape_interval_seconds*3 ELSE expect_every_seconds END,expect_daily_by,4
    FROM pulse.sources WHERE base_id=${baseId}::uuid AND NOT deleted AND enabled AND stale_since IS NOT NULL
  )`;
  const attentionRows = await sql<AttentionRow[]>`${attentionSet} SELECT * FROM attention ORDER BY priority,since,id
    LIMIT ${page.data.attentionLimit} OFFSET ${page.data.attentionOffset}`;
  const [count] = await sql<{ total: number }[]>`${attentionSet} SELECT count(*)::int AS total FROM attention`;
  const activities = await sql<
    (Omit<OverviewActivity, "at"> & { at: Date; cursor_at: string })[]
  >`SELECT id,at,kind,actor,data,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM pulse.base_activity
    WHERE base_id=${baseId}::uuid AND (${cursor === null} OR (at,id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
    ORDER BY at DESC,id DESC LIMIT ${page.data.activityLimit + 1}`;
  const items = activities
    .slice(0, page.data.activityLimit)
    .map(({ id, at, kind, actor, data }) => ({ id, at: iso(at), kind, actor, data }));
  const last = activities[Math.min(activities.length, page.data.activityLimit) - 1];
  const [health] = await sql<{ unavailable: boolean; read_at: Date; state: string }[]>`
    SELECT s.state,(coalesce(i.outage_started_at IS NOT NULL,false) OR s.state<>'active') AS unavailable,clock_timestamp() AS read_at
    FROM pulse.base_stores s LEFT JOIN pulse.store_instance i ON i.singleton WHERE s.base_id=${baseId}::uuid`;
  if (!health) return fail(err.notFound("Pulse base"));
  const total = count?.total ?? 0;
  return ok({
    baseId: base.short_id,
    name: base.name,
    timezone: base.timezone,
    readAt: iso(health.read_at),
    storeUnavailable: !configured || health.unavailable || numbers.some((tile) => tile.errorCode === "STORE_UNAVAILABLE"),
    sources: sourceSummary ?? { total: 0, current: 0 },
    attention: {
      items: attentionRows.map(
        ({
          id,
          kind,
          reference,
          name,
          state,
          severity,
          since,
          lastCheckedAt,
          errorCode,
          key,
          value,
          comparison,
          threshold,
          newestDataAt,
          expectEverySeconds,
          expectDailyBy,
        }) => ({
          id,
          kind,
          reference,
          name,
          state,
          severity,
          since: iso(since),
          lastCheckedAt: isoNullable(lastCheckedAt),
          errorCode,
          key,
          value,
          comparison,
          threshold,
          newestDataAt: isoNullable(newestDataAt),
          expectEverySeconds,
          expectDailyBy,
        }),
      ),
      total,
      nextOffset: page.data.attentionOffset + attentionRows.length < total ? page.data.attentionOffset + attentionRows.length : null,
    },
    numbers,
    activity: { items, nextCursor: activities.length > items.length && last ? JSON.stringify({ at: last.cursor_at, id: last.id }) : null },
  });
};
