import type { CapabilityClientResult, CapabilityInvocation } from "@k2b/cloud/capabilities";
import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { z } from "zod";

/**
 * Gustav reads Code only through Core's public `core.code.*` queries, like any application could. These schemas keep
 * the few fields the UI shows; Core's contract stays the authority and may add fields.
 */
const CodeItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(["draft", "active", "paused", "deleting"]),
});
const CodeListSchema = z.object({ items: z.array(CodeItemSchema), nextCursor: z.string().nullable() });
const RunListSchema = z.object({
  items: z.array(
    z.object({
      state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]),
      createdAt: z.string(),
      endedAt: z.string().nullable(),
    }),
  ),
});

/** A place's own name, its type's title, its link, and whether its type can own Code at all. */
export type CodePlace = { name?: string; type?: string; href?: string; canOwnCode?: boolean };

export type CodeOwnerFilter = { kind: "person"; userId: string } | { kind: "resource"; ref: CloudResourceRef };
export type CodeRunSummary = z.infer<typeof RunListSchema>["items"][number];
/** `lastRun` is null when the Code never ran, and undefined when Core could not read its run history. */
export type CodeSummary = z.infer<typeof CodeItemSchema> & { lastRun: CodeRunSummary | null | undefined };
/** One page of Code the person may see for an owner. `nextCursor` continues the list; null means it is complete. */
export type CodeSummaryPage = { items: CodeSummary[]; nextCursor: string | null };

/** The server and the browser pass their own capability transport; both call the same public queries. */
export type CodeQueryInvoke = <T extends z.ZodType>(
  invocation: CapabilityInvocation,
  schema: T,
) => Promise<CapabilityClientResult<z.output<T>>>;

/** Core pages at most 20 Code items; the list loads further pages on request. */
export const CODE_SUMMARY_LIMIT = 20;

export class CodeSummaryError extends Error {}

const query = (capabilityId: string, input: unknown): CapabilityInvocation => ({ appId: "core", capabilityId, kind: "query", input });

/** Whether the person owns any Code; one item is enough. */
export const hasPersonalCode = async (invoke: CodeQueryInvoke, userId: string): Promise<boolean> => {
  const result = await invoke(query("code.list", { owner: { kind: "person", userId }, limit: 1 }), CodeListSchema);
  if (!result.ok) throw new CodeSummaryError(result.error.message);
  return result.data.data.items.length > 0;
};

/**
 * One page of Code for one owner, each with its newest run. Core lists only Code the person may read, so a
 * resource without readable Code yields no items. Run lookups are bounded by the page size and run in parallel.
 */
export const loadCodeSummaries = async (invoke: CodeQueryInvoke, owner: CodeOwnerFilter, cursor?: string): Promise<CodeSummaryPage> => {
  const listed = await invoke(query("code.list", { owner, limit: CODE_SUMMARY_LIMIT, ...(cursor ? { cursor } : {}) }), CodeListSchema);
  if (!listed.ok) throw new CodeSummaryError(listed.error.message);
  const items = await Promise.all(
    listed.data.data.items.map(async (code): Promise<CodeSummary> => {
      const runs = await invoke(query("code.run.list", { codeId: code.id, limit: 1 }), RunListSchema);
      // A missing run history does not hide the Code; it shows that its last run is unknown.
      return { ...code, lastRun: runs.ok ? (runs.data.data.items[0] ?? null) : undefined };
    }),
  );
  return { items, nextCursor: listed.data.data.nextCursor };
};

export type CodeStatusTone = "success" | "warning" | "danger" | "neutral";

/** One status per Code: paused and failed runs need attention before "on". */
export const codeStatus = (code: CodeSummary): { key: "on" | "paused" | "draft" | "deleting" | "failed"; tone: CodeStatusTone } => {
  if (code.state === "paused") return { key: "paused", tone: "warning" };
  if (code.state === "draft") return { key: "draft", tone: "neutral" };
  if (code.state === "deleting") return { key: "deleting", tone: "neutral" };
  if (code.lastRun?.state === "failed") return { key: "failed", tone: "danger" };
  return { key: "on", tone: "success" };
};

const AttentionSchema = z.object({
  items: z.array(
    z.object({
      code: z.object({
        id: z.string(),
        title: z.string(),
        owner: z.union([
          z.object({ kind: z.literal("resource"), ref: z.object({ type: z.string(), id: z.string() }) }),
          z.object({ kind: z.literal("app"), appId: z.string() }),
          z.object({ kind: z.literal("person") }),
        ]),
      }),
      reasons: z.array(z.enum(["paused", "run_failed", "access_removed"])),
      lastRunAt: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type CodeAttentionReason = "paused" | "run_failed" | "access_removed";
/** Who owns Code that waits: a resource, or a whole app. */
export type CodeAttentionOwner = { kind: "resource"; ref: CloudResourceRef } | { kind: "app"; appId: string };
/** Code of a place the person administers that needs them. */
export type CodeAttentionItem = {
  codeId: string;
  title: string;
  owner: CodeAttentionOwner | null;
  reasons: CodeAttentionReason[];
  lastRunAt: string | null;
};
/** `nextCursor` continues after the windows checked so far; null means every candidate was checked. */
export type CodeAttentionPage = { items: CodeAttentionItem[]; nextCursor: string | null };
/** Core checks 50 candidates per window; one view follows at most this many windows before offering to continue. */
export const CODE_ATTENTION_WINDOWS = 4;

/**
 * Code that waits for the person as an administrator of its place: paused, or failed (also because a target removed
 * its access). Core pages its candidate window; this follows up to `CODE_ATTENTION_WINDOWS` windows from `cursor`.
 */
export const loadCodeAttention = async (invoke: CodeQueryInvoke, cursor?: string): Promise<CodeAttentionPage> => {
  const items: CodeAttentionItem[] = [];
  let next: string | null = cursor ?? null;
  for (let window = 0; window < CODE_ATTENTION_WINDOWS; window++) {
    const result = await invoke(query("code.attention.list", next ? { cursor: next } : {}), AttentionSchema);
    if (!result.ok) throw new CodeSummaryError(result.error.message);
    for (const item of result.data.data.items)
      items.push({
        codeId: item.code.id,
        title: item.code.title,
        owner: item.code.owner.kind === "person" ? null : item.code.owner,
        reasons: item.reasons,
        lastRunAt: item.lastRunAt,
      });
    next = result.data.data.nextCursor;
    if (!next) break;
  }
  return { items, nextCursor: next };
};

const RunCountSchema = z.object({ runs: z.number().int(), failed: z.number().int() });
export type CodeRunCount = z.infer<typeof RunCountSchema>;
/** Runs and failed runs of the person's own Code since `since`. */
export const countOwnRunsSince = async (invoke: CodeQueryInvoke, since: string): Promise<CodeRunCount> => {
  const result = await invoke(query("code.run.count", { since }), RunCountSchema);
  if (!result.ok) throw new CodeSummaryError(result.error.message);
  return result.data.data;
};

const zoned = (timeZone: string, at: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
};
/** How far the zone's wall clock is ahead of UTC at one instant, in milliseconds. */
const offsetAt = (timeZone: string, at: Date) => {
  const local = zoned(timeZone, at);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - Math.floor(at.getTime() / 1000) * 1000;
};
/**
 * The instant the person's current day began in their time zone, so "today" means their day on server and browser.
 * Clock changes can repeat or skip local midnight, so it tries the zone's offsets around that day and takes the
 * earliest instant that already falls on the local date.
 */
export const startOfDayIn = (timeZone: string, now: Date): string => {
  const today = zoned(timeZone, now);
  const midnightAsUtc = Date.UTC(today.year, today.month - 1, today.day);
  const hour = 60 * 60 * 1000;
  const offsets = new Set([-36, -24, -12, 0, 12].map((hours) => offsetAt(timeZone, new Date(midnightAsUtc + hours * hour))));
  offsets.add(offsetAt(timeZone, now));
  const sameDay = (instant: number) => {
    const local = zoned(timeZone, new Date(instant));
    return local.year === today.year && local.month === today.month && local.day === today.day;
  };
  const starts = [...offsets].map((offset) => midnightAsUtc - offset).filter(sameDay);
  // No offset lands on local midnight when the day starts later (midnight skipped): its first hour on the date.
  let start = starts.length > 0 ? Math.min(...starts) : midnightAsUtc - offsetAt(timeZone, now);
  while (sameDay(start - hour)) start -= hour;
  return new Date(start).toISOString();
};
