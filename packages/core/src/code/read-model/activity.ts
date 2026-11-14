import { sql } from "@k2b/cloud";
import { visitCronDaySlots } from "@k2b/cloud/code";
import {
  CODE_READ_MODEL_TIMELINE_LIMIT,
  type CodeActivityReadModel,
  CodeCheckedVersionManifestSchema,
  codeReadModelContracts,
} from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import type { z } from "zod";
import { type CodeContext, CodeDataError } from "../access";
import { readCode } from "../store";
import { codeReadModelMessages } from "./messages";
import { readModelNames } from "./names";

type Mark = CodeActivityReadModel["timeline"]["marks"][number];
type Counter = { key: string; automationKey: string; count: number; total: number };
type Recent = { operation: string; target: { type: string; id: string } | null; manifest: unknown; runId: string; at: string };
export type ActivityData = {
  from: Date;
  to: Date;
  week: Date;
  counters: Counter[];
  recent: Recent[];
  marks: Mark[];
  total: number;
  manifest: unknown;
};

/** The Code page's activity data is one statement, independent of its number of runs or calls. */
export async function readCodeActivityData(input: z.infer<typeof codeReadModelContracts.activity.input>): Promise<ActivityData> {
  const [row] = await sql<ActivityData[]>`
    WITH bounds AS MATERIALIZED (
      SELECT ${input.day}::date::timestamp AT TIME ZONE ${input.timeZone} AS lo,
        (${input.day}::date+1)::timestamp AT TIME ZONE ${input.timeZone} AS hi
    ), day_runs AS MATERIALIZED (
      SELECT id,created_at,state FROM code.runs,bounds WHERE code_id=${input.codeId} AND created_at>=lo AND created_at<hi
    ), day_count AS (SELECT count(*)::int AS total FROM day_runs)
    SELECT lo AS "from",hi AS "to",date_trunc('week',${input.day}::date::timestamp) AT TIME ZONE 'UTC' AS week,
      (SELECT manifest FROM code.versions v JOIN code.codes c ON c.active_version_id=v.id WHERE c.id=${input.codeId}) AS manifest,
      COALESCE((SELECT jsonb_agg(item) FROM (
        SELECT entrypoint AS "automationKey",kv.key,kv.value::bigint AS count,count(*) OVER()::int AS total
        FROM code.activity_weeks w CROSS JOIN LATERAL jsonb_each_text(w.counts) kv
        WHERE code_id=${input.codeId} AND week=date_trunc('week',${input.day}::date::timestamp) AT TIME ZONE 'UTC'
        ORDER BY entrypoint,kv.key LIMIT 50
      ) item),'[]'::jsonb) AS counters,
      COALESCE((SELECT jsonb_agg(item) FROM (
        SELECT r.id AS "runId",c.ended_at AS at,c.call->>'capability' AS operation,c.call->'target' AS target,v.manifest
        FROM code.runs r JOIN code.calls c ON c.run_id=r.id JOIN code.versions v ON v.id=r.version_id
        WHERE c.code_id=${input.codeId} AND c.confirmed_effect AND NOT c.replayed AND c.state='succeeded'
        ORDER BY c.ended_at DESC,r.id DESC,c.ordinal DESC LIMIT 6
      ) item),'[]'::jsonb) AS recent,
      day_count.total,
      CASE WHEN day_count.total<=200 THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('at',created_at,'state',CASE WHEN state='cancelled' THEN 'failed' ELSE state END,'count',1,'runId',id) ORDER BY created_at,id) FROM day_runs),'[]'::jsonb)
      ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object('at',at,'state','group','count',n) ORDER BY at) FROM (
        SELECT lo+floor(extract(epoch FROM (created_at-lo))/extract(epoch FROM (hi-lo))*200)*((hi-lo)/200) AS at,count(*)::int AS n
        FROM day_runs GROUP BY 1
      ) buckets),'[]'::jsonb) END AS marks
    FROM bounds CROSS JOIN day_count`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code activity not found.");
  return row;
}
/** Group by equal portions of this local day, including 23/25-hour DST days. */
export function boundTimeline(marks: readonly Mark[], from: Date, to: Date): Mark[] {
  if (marks.length <= CODE_READ_MODEL_TIMELINE_LIMIT) return [...marks].sort((a, b) => a.at.localeCompare(b.at));
  const buckets = new Map<number, number>();
  for (const mark of marks) {
    const bucket = Math.min(199, Math.max(0, Math.floor(((Date.parse(mark.at) - +from) / (+to - +from)) * 200)));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + mark.count);
  }
  return [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([bucket, count]) => ({ at: new Date(+from + (bucket * (+to - +from)) / 200).toISOString(), state: "group", count }));
}
export async function loadCodeActivityReadModel(
  raw: z.input<typeof codeReadModelContracts.activity.input>,
  context: CodeContext,
): Promise<CodeActivityReadModel> {
  const input = codeReadModelContracts.activity.input.parse(raw);
  try {
    // PostgreSQL interprets numeric offsets with POSIX signs; accept named zones only.
    if (/^[+-]/.test(input.timeZone)) throw new RangeError("Offset time zone");
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
  } catch {
    throw new CodeDataError("BAD_INPUT", "Invalid time zone.");
  }
  const { code } = await readCode(input.codeId, context);
  const data = await readCodeActivityData(input);
  const manifest = CodeCheckedVersionManifestSchema.safeParse(data.manifest);
  const manifests = [data.manifest, ...data.recent.map((item) => item.manifest)].flatMap((value) => {
    const parsed = CodeCheckedVersionManifestSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const names = await readModelNames(
    manifests,
    context,
    data.counters.map((item) => item.key),
    data.recent.flatMap((item) => (item.target ? [item.target] : [])),
  );
  const { t } = codeReadModelMessages.resolve(context.locale ? [context.locale] : []);
  const planned: Mark[] = [];
  // Keep at most 200 buckets in memory even for a schedule that fires every minute.
  const plannedBuckets = new Map<number, number>();
  let plannedTotal = 0;
  const addPlanned = (at: Date) => {
    if (+at <= Date.now() || +at < +data.from || +at >= +data.to) return;
    plannedTotal++;
    if (planned.length < 200) planned.push({ at: at.toISOString(), state: "planned", count: 1 });
    const bucket = Math.min(199, Math.floor(((+at - +data.from) / (+data.to - +data.from)) * 200));
    plannedBuckets.set(bucket, (plannedBuckets.get(bucket) ?? 0) + 1);
  };
  if (code.state === "active" && manifest.success) {
    const timeZone = await coreSettings.get<string>("app.timezone");
    for (const entry of manifest.data.entrypoints) {
      context.signal?.throwIfAborted();
      if (entry.kind !== "schedule") continue;
      if (entry.at) addPlanned(new Date(entry.at));
      else if (entry.cron) visitCronDaySlots({ cron: entry.cron, timezone: entry.timeZone ?? timeZone }, data.from, data.to, addPlanned);
    }
  }
  const future: Mark[] =
    plannedTotal <= 200
      ? planned
      : [...plannedBuckets].map(([bucket, count]) => ({
          at: new Date(+data.from + (bucket * (+data.to - +data.from)) / 200).toISOString(),
          state: "group",
          count,
        }));
  const totalCounters = data.counters[0]?.total ?? 0;
  return {
    week: data.week.toISOString(),
    counters: {
      items: data.counters.map((item) => ({
        key: item.key,
        automationKey: item.automationKey,
        count: Number(item.count),
        text: t.calls({ action: names.operation(item.key).title, count: Number(item.count) }),
      })),
      more: Math.max(0, totalCounters - 50),
      moreText: totalCounters > 50 ? t.more({ count: totalCounters - 50 }) : null,
    },
    recent: data.recent.map((item) => {
      const target = item.target ? names.target(item.target) : null;
      return {
        text: target
          ? t.mayDo({ action: t.calls({ action: names.operation(item.operation).title, count: 1 }), target: target.name })
          : t.calls({ action: names.operation(item.operation).title, count: 1 }),
        at: new Date(item.at).toISOString(),
        runId: item.runId,
        ...(target?.readable && target.href ? { href: target.href } : {}),
      };
    }),
    timeline: {
      from: data.from.toISOString(),
      to: data.to.toISOString(),
      total: data.total + plannedTotal,
      marks: boundTimeline(
        [...data.marks.map((mark) => ({ ...mark, at: new Date(mark.at).toISOString() })), ...future],
        data.from,
        data.to,
      ),
    },
  };
}
