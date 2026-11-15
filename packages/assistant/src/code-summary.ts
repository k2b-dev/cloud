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
  /** When the Code was paused; absent from older Core answers. */
  pausedAt: z.string().nullable().optional(),
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

const AutomationTargetSchema = z.object({
  type: z.string(),
  id: z.string(),
  title: z.string().nullable(),
  typeTitle: z.string().nullable(),
});
const AutomationListSchema = z.object({
  items: z.array(
    z.object({
      entrypoint: z.string(),
      title: z.string().optional(),
      kind: z.enum(["schedule", "manual", "event", "route"]),
      cron: z.string().nullable(),
      at: z.string().optional(),
      timeZone: z.string().optional(),
      nextRunAt: z.string().nullable(),
      lastRun: z
        .object({ state: RunListSchema.shape.items.element.shape.state, createdAt: z.string(), endedAt: z.string().nullable() })
        .nullable(),
      missingTargets: z.array(AutomationTargetSchema),
    }),
  ),
  removedTargets: z.array(AutomationTargetSchema),
});
export type CodeAutomation = z.infer<typeof AutomationListSchema>["items"][number];
export type CodeAutomationTarget = z.infer<typeof AutomationTargetSchema>;

/** A place's own name, its type's title, its link, and whether its type can own Code at all. */
export type CodePlace = { name?: string; type?: string; href?: string; canOwnCode?: boolean };

export type CodeOwnerFilter = { kind: "person"; userId: string } | { kind: "resource"; ref: CloudResourceRef };
export type CodeRunSummary = z.infer<typeof RunListSchema>["items"][number];
/**
 * `lastRun` is null when the Code never ran, and undefined when Core could not read its run history. `automations` is
 * undefined when Core could not list them; the Code then shows as one row.
 */
export type CodeSummary = z.infer<typeof CodeItemSchema> & {
  lastRun: CodeRunSummary | null | undefined;
  automations?: CodeAutomation[];
  /** Targets that removed access, also when no automation could be named for them. */
  removedTargets?: CodeAutomationTarget[];
};
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
 * One page of Code for one owner, each with its newest run and its automations. Core lists only Code the person may read, so a
 * resource without readable Code yields no items. Run lookups are bounded by the page size and run in parallel.
 */
export const loadCodeSummaries = async (invoke: CodeQueryInvoke, owner: CodeOwnerFilter, cursor?: string): Promise<CodeSummaryPage> => {
  const listed = await invoke(query("code.list", { owner, limit: CODE_SUMMARY_LIMIT, ...(cursor ? { cursor } : {}) }), CodeListSchema);
  if (!listed.ok) throw new CodeSummaryError(listed.error.message);
  const items = await Promise.all(
    listed.data.data.items.map(async (code): Promise<CodeSummary> => {
      const [runs, automations] = await Promise.all([
        invoke(query("code.run.list", { codeId: code.id, limit: 1 }), RunListSchema),
        invoke(query("code.automation.list", { codeId: code.id }), AutomationListSchema).catch(() => null),
      ]);
      // A missing run history does not hide the Code; it shows that its last run is unknown.
      return {
        ...code,
        lastRun: runs.ok ? (runs.data.data.items[0] ?? null) : undefined,
        ...(automations?.ok ? { automations: automations.data.data.items, removedTargets: automations.data.data.removedTargets } : {}),
      };
    }),
  );
  return { items, nextCursor: listed.data.data.nextCursor };
};

export type CodeStatusTone = "success" | "warning" | "danger" | "neutral";

export type CodeStatusKey = "on" | "paused" | "draft" | "deleting" | "failed" | "access_missing";

/** One status per Code: pausing the whole Code, removed access and failed runs need attention before "on". */
export const codeStatus = (code: CodeSummary): { key: CodeStatusKey; tone: CodeStatusTone } => {
  if (code.state === "paused") return { key: "paused", tone: "warning" };
  if (code.state === "draft") return { key: "draft", tone: "neutral" };
  if (code.state === "deleting") return { key: "deleting", tone: "neutral" };
  if ((code.removedTargets?.length ?? 0) > 0) return { key: "access_missing", tone: "warning" };
  if (code.lastRun?.state === "failed") return { key: "failed", tone: "danger" };
  return { key: "on", tone: "success" };
};

/**
 * One status per automation. Only the whole Code can pause, so an automation never pauses by itself: what it can lack
 * is its access, while the others keep running.
 */
export const automationStatus = (code: CodeSummary, automation: CodeAutomation): { key: CodeStatusKey; tone: CodeStatusTone } => {
  if (code.state === "paused") return { key: "paused", tone: "warning" };
  if (code.state === "draft") return { key: "draft", tone: "neutral" };
  if (code.state === "deleting") return { key: "deleting", tone: "neutral" };
  if (automation.missingTargets.length > 0) return { key: "access_missing", tone: "warning" };
  if (automation.lastRun?.state === "failed") return { key: "failed", tone: "danger" };
  return { key: "on", tone: "success" };
};

/** The earliest next run of a Code's automations, or null when none is due. */
export const nextCodeRun = (code: Pick<CodeSummary, "automations">): string | null =>
  (code.automations ?? []).reduce<string | null>(
    (earliest, automation) =>
      automation.nextRunAt && (!earliest || Date.parse(automation.nextRunAt) < Date.parse(earliest)) ? automation.nextRunAt : earliest,
    null,
  );

/** The earliest next run of one Code's automations, from the same list "My apps" reads; null when none is due or unknown. */
export const loadCodeNextRun = async (invoke: CodeQueryInvoke, codeId: string): Promise<string | null> => {
  const result = await invoke(query("code.automation.list", { codeId }), AutomationListSchema).catch(() => null);
  return result?.ok ? nextCodeRun({ automations: result.data.data.items }) : null;
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
      reasons: z.array(z.enum(["paused", "run_failed", "access_missing", "approval_pending"])),
      lastRunAt: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type CodeAttentionReason = "paused" | "run_failed" | "access_missing" | "approval_pending";
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
 * Code that waits for the person as an administrator of its place, with Core's reasons. Core pages its candidate
 * window; this follows up to `CODE_ATTENTION_WINDOWS` windows from `cursor`.
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
