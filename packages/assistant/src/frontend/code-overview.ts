import {
  CODE_READ_MODEL_TIMELINE_LIMIT,
  type CodeActivityReadModel,
  CodeActivityReadModelSchema,
  CodeRunReadModelSchema,
} from "@k2b/cloud/contracts/code-read-model";
import { describeCodeSchedule, describeCodeTiming } from "@k2b/cloud/ssr/code-schedule";
import { z } from "zod";
import {
  type CodeAutomation,
  type CodeOwnerFilter,
  type CodeQueryInvoke,
  type CodeSummary,
  type CodeSummaryPage,
  loadCodeSummaries,
} from "../code-summary";
import { assistantMessages } from "./messages";

/**
 * "My apps & automations" reads, per listed Code, what its card and the day line need: its last runs, its activity of
 * the person's day (effects and today's marks) and, after a failed run, why it failed. Every read is one of Core's
 * public Code queries, bounded by the list page and run in parallel.
 */

/** Runs a card shows as bars, newest last. */
export const CODE_CARD_RUNS = 8;

const CardRunsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]),
      createdAt: z.string(),
      startedAt: z.string().nullable(),
      endedAt: z.string().nullable(),
    }),
  ),
});
export type CodeCardRun = z.infer<typeof CardRunsSchema>["items"][number];

/**
 * What a card adds to a Code's summary. Each part is null when Core could not answer it; the card then leaves that
 * part out and the rest stays.
 */
export type CodeCardExtras = {
  /** Newest first, at most `CODE_CARD_RUNS`. */
  runs: CodeCardRun[] | null;
  activity: CodeActivityReadModel | null;
  /** Why the newest run failed, in Core's words; null when it did not fail or Core could not say. */
  failure: string | null;
};
export type CodeOverviewItem = CodeSummary & { extras?: CodeCardExtras };
/** A Code list page whose items may already carry their card extras (from the server); the rest load in the browser. */
export type CodeOverviewPage = { items: CodeOverviewItem[]; nextCursor: string | null };

const query = (capabilityId: string, input: unknown) => ({ appId: "core", capabilityId, kind: "query" as const, input });

/** The person's local date as ISO `YYYY-MM-DD`, the day the read model's timeline covers. */
export const localDay = (timeZone: string, now: Date): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/** One Code's card extras. A failed part stays null, so one slow or refused read never hides the card. */
export const loadCodeCardExtras = async (
  invoke: CodeQueryInvoke,
  codeId: string,
  day: { day: string; timeZone: string },
): Promise<CodeCardExtras> => {
  const [runs, activity] = await Promise.all([
    invoke(query("code.run.list", { codeId, limit: CODE_CARD_RUNS }), CardRunsSchema)
      .then((result) => (result.ok ? result.data.data.items : null))
      .catch(() => null),
    invoke(query("code.activity.words", { codeId, day: day.day, timeZone: day.timeZone }), CodeActivityReadModelSchema)
      .then((result) => (result.ok ? result.data.data : null))
      .catch(() => null),
  ]);
  const newest = runs?.[0];
  const failure =
    newest && (newest.state === "failed" || newest.state === "cancelled")
      ? await invoke(query("code.run.words", { codeId, runId: newest.id }), CodeRunReadModelSchema)
          .then((result) => (result.ok ? result.data.data.reason : null))
          .catch(() => null)
      : null;
  return { runs, activity, failure };
};

/** Adds card extras to every item that has none yet, all in parallel; the page bounds how many there are. */
export const withCardExtras = async (
  invoke: CodeQueryInvoke,
  items: readonly CodeOverviewItem[],
  day: { day: string; timeZone: string },
): Promise<CodeOverviewItem[]> =>
  Promise.all(items.map(async (item) => (item.extras ? item : { ...item, extras: await loadCodeCardExtras(invoke, item.id, day) })));

/** One page of the person's own Code with card extras: the server's first render and the browser's reloads read the same. */
export const loadCodeOverview = async (
  invoke: CodeQueryInvoke,
  owner: Extract<CodeOwnerFilter, { kind: "person" }>,
  options: { timeZone: string; now: Date; cursor?: string },
): Promise<CodeOverviewPage> => {
  const page: CodeSummaryPage = await loadCodeSummaries(invoke, owner, options.cursor);
  const day = { day: localDay(options.timeZone, options.now), timeZone: options.timeZone };
  return { items: await withCardExtras(invoke, page.items, day), nextCursor: page.nextCursor };
};

/** What a card's status says, in the order that needs attention first. */
export type CodeCardStatus = "running" | "failed" | "access_missing" | "paused" | "draft" | "deleting" | "on";

export const cardStatus = (item: CodeOverviewItem): CodeCardStatus => {
  if (item.state === "paused") return "paused";
  if (item.state === "draft") return "draft";
  if (item.state === "deleting") return "deleting";
  const newest = item.extras?.runs?.[0];
  if (newest && (newest.state === "running" || newest.state === "queued")) return "running";
  if ((item.removedTargets?.length ?? 0) > 0) return "access_missing";
  const last = newest ?? item.lastRun;
  if (last && (last.state === "failed" || last.state === "cancelled")) return "failed";
  return "on";
};

/** Code that needs the person: a failed run or missing access. */
export const needsPerson = (status: CodeCardStatus) => status === "failed" || status === "access_missing";

export type DayMarkState = "succeeded" | "failed" | "planned" | "running" | "skipped" | "group";
/** One mark on the day line; `at` is its place on the day from 0 to 1. */
export type DayMark = { at: number; state: DayMarkState; count: number; codeId: string | null; runId: string | null };
export type DayLine = {
  marks: DayMark[];
  /** Listed Code whose day could not be read: the counts leave them out, and the line says so. */
  missing: number;
  succeeded: number;
  failed: number;
  planned: number;
  /** Runs that run right now or are about to start. */
  running: number;
  /** Runs Core only counted in groups: too many to tell one by one. */
  grouped: number;
};

/**
 * All listed Code's marks of the person's day on one line, in time order. Above `CODE_READ_MODEL_TIMELINE_LIMIT` marks,
 * equal portions of the day merge into groups, as Core groups one Code's day; the counts stay exact.
 */
/** One planned mark per hour at most. */
const PLANNED_HOURS = 24;
export const dayLine = (items: readonly CodeOverviewItem[]): DayLine | null => {
  const days = items.flatMap((item) => (item.extras?.activity ? [{ codeId: item.id, timeline: item.extras.activity.timeline }] : []));
  if (days.length === 0) return null;
  // Extras that loaded without their day: a partial answer, never a complete-looking total.
  const missing = items.filter((item) => item.extras && !item.extras.activity).length;
  const counts = { succeeded: 0, failed: 0, planned: 0, running: 0, grouped: 0 };
  const marks: DayMark[] = [];
  for (const { codeId, timeline } of days) {
    const from = Date.parse(timeline.from);
    const span = Date.parse(timeline.to) - from;
    for (const mark of timeline.marks) {
      const state: DayMarkState = mark.state === "queued" ? "running" : mark.state;
      // Skipped runs did not run; the line shows them, the sentence does not count them.
      if (state === "group") counts.grouped += mark.count;
      else if (state !== "skipped") counts[state] += mark.count;
      marks.push({
        at: span > 0 ? Math.min(1, Math.max(0, (Date.parse(mark.at) - from) / span)) : 0,
        state,
        count: mark.count,
        codeId,
        runId: mark.runId ?? null,
      });
    }
  }
  // Planned starts carry no result: above one per hour they share one mark per hour, so a dense day stays readable on
  // a phone. Runs that happened keep their own mark; the counts stay exact.
  const planned = marks.filter((mark) => mark.state === "planned");
  if (planned.length > PLANNED_HOURS) {
    const hours = new Map<number, DayMark>();
    for (const mark of planned) {
      const hour = Math.min(PLANNED_HOURS - 1, Math.floor(mark.at * PLANNED_HOURS));
      const known = hours.get(hour);
      hours.set(
        hour,
        known ? { ...known, count: known.count + mark.count, runId: null } : { ...mark, at: (hour + 0.5) / PLANNED_HOURS, runId: null },
      );
    }
    marks.splice(0, marks.length, ...marks.filter((mark) => mark.state !== "planned"), ...hours.values());
  }
  marks.sort((a, b) => a.at - b.at);
  if (marks.length <= CODE_READ_MODEL_TIMELINE_LIMIT) return { marks, missing, ...counts };
  const buckets = new Map<number, number>();
  for (const mark of marks) {
    const bucket = Math.min(CODE_READ_MODEL_TIMELINE_LIMIT - 1, Math.floor(mark.at * CODE_READ_MODEL_TIMELINE_LIMIT));
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + mark.count);
  }
  return {
    marks: [...buckets].map(([bucket, count]) => ({
      at: bucket / CODE_READ_MODEL_TIMELINE_LIMIT,
      state: "group",
      count,
      codeId: null,
      runId: null,
    })),
    missing,
    ...counts,
  };
};

/**
 * When an automation runs, as a sentence that can stand alone: "Mondays at 07:00", "On an event". A schedule Cloud cannot
 * put into words says only that a schedule starts it, never the expression itself.
 */
export const automationTiming = (automation: Pick<CodeAutomation, "kind" | "cron" | "at" | "timeZone">, locale: string): string => {
  const t = assistantMessages.resolve([locale]).t;
  if (automation.kind === "event") return t.appsOnEvent;
  if (automation.kind === "manual") return t.appsByHand;
  if (automation.kind === "route") return t.appsAsPage;
  if (!automation.at && (!automation.cron || describeCodeSchedule(automation.cron, locale) === automation.cron)) return t.appsOnSchedule;
  const text = describeCodeTiming(automation, locale) ?? t.appsOnSchedule;
  const timed = /^(.*\S) (\d{2}:\d{2})$/.exec(text);
  const sentence = timed ? t.appsScheduleAt({ when: timed[1]!, time: timed[2]! }) : text;
  return sentence.charAt(0).toLocaleUpperCase(locale) + sentence.slice(1);
};
