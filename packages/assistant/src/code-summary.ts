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

export type CodeOwnerFilter = { kind: "person"; userId: string } | { kind: "resource"; ref: CloudResourceRef };
export type CodeRunSummary = z.infer<typeof RunListSchema>["items"][number];
export type CodeSummary = z.infer<typeof CodeItemSchema> & { lastRun: CodeRunSummary | null };
/** One page of Code the person may see for an owner. `more` means Core has further Code than shown. */
export type CodeSummaryPage = { items: CodeSummary[]; more: boolean };

/** The server and the browser pass their own capability transport; both call the same public queries. */
export type CodeQueryInvoke = <T extends z.ZodType>(
  invocation: CapabilityInvocation,
  schema: T,
) => Promise<CapabilityClientResult<z.output<T>>>;

/** Core pages at most 20 Code items; the UI shows one page and says when there is more. */
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
 * The first page of Code for one owner, each with its newest run. Core lists only Code the person may read, so a
 * resource without readable Code yields no items. Run lookups are bounded by the page size and run in parallel.
 */
export const loadCodeSummaries = async (invoke: CodeQueryInvoke, owner: CodeOwnerFilter): Promise<CodeSummaryPage> => {
  const listed = await invoke(query("code.list", { owner, limit: CODE_SUMMARY_LIMIT }), CodeListSchema);
  if (!listed.ok) throw new CodeSummaryError(listed.error.message);
  const items = await Promise.all(
    listed.data.data.items.map(async (code): Promise<CodeSummary> => {
      const runs = await invoke(query("code.run.list", { codeId: code.id, limit: 1 }), RunListSchema);
      // A missing run history does not hide the Code; it shows without a last run.
      return { ...code, lastRun: runs.ok ? (runs.data.data.items[0] ?? null) : null };
    }),
  );
  return { items, more: listed.data.data.nextCursor !== null };
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
