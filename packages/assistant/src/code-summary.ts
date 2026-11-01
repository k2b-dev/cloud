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
        owner: z.object({ kind: z.string(), ref: z.object({ type: z.string(), id: z.string() }).optional() }),
      }),
      reasons: z.array(z.enum(["paused", "run_failed", "access_removed"])),
      lastRunAt: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
});
export type CodeAttentionReason = "paused" | "run_failed" | "access_removed";
/** Code of a place the person administers that needs them, with that place when it is a resource. */
export type CodeAttentionItem = {
  codeId: string;
  title: string;
  owner: CloudResourceRef | null;
  reasons: CodeAttentionReason[];
  lastRunAt: string | null;
};
export type CodeAttentionPage = { items: CodeAttentionItem[]; truncated: boolean };

/** Code that waits for the person as an administrator of its place: paused, failed, or without access at a target. */
export const loadCodeAttention = async (invoke: CodeQueryInvoke): Promise<CodeAttentionPage> => {
  const result = await invoke(query("code.attention.list", {}), AttentionSchema);
  if (!result.ok) throw new CodeSummaryError(result.error.message);
  return {
    items: result.data.data.items.map((item) => ({
      codeId: item.code.id,
      title: item.code.title,
      owner: item.code.owner.ref ?? null,
      reasons: item.reasons,
      lastRunAt: item.lastRunAt,
    })),
    truncated: result.data.data.truncated,
  };
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
 * The offset is taken at that midnight, so days on which the clocks change start at the right hour too.
 */
export const startOfDayIn = (timeZone: string, now: Date): string => {
  const today = zoned(timeZone, now);
  const midnightAsUtc = Date.UTC(today.year, today.month - 1, today.day);
  let start = midnightAsUtc - offsetAt(timeZone, now);
  start = midnightAsUtc - offsetAt(timeZone, new Date(start));
  return new Date(start).toISOString();
};
