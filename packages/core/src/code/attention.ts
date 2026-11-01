import { sql } from "@k2b/cloud";
import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { z } from "zod";
import { type CodeContext, CodeOwnerUnavailableError, codePermission, codePerson } from "./access";
import { reconcileCodeAccess } from "./activation-maintenance";
import { type Code, CodeIdSchema, CodeOwnerSchema, CodeSchema } from "./contracts";
import { type CodeRow, listCodes, mapCode } from "./store";

/** Why an owner's Code needs someone: its newest run of an entrypoint failed, a target removed access, or a version waits for approval. */
export const CodeAttentionReasonSchema = z.enum(["run_failed", "access_missing", "approval_pending"]);
export type CodeAttentionReason = z.infer<typeof CodeAttentionReasonSchema>;

/** One SSR-friendly query per owner page: which readable Code of this owner needs attention. */
export const codeAttentionContracts = {
  attention: {
    input: z.object({ owner: CodeOwnerSchema.describe("Exact Code owner whose Code the page shows.") }).strict(),
    data: z
      .object({
        items: z.array(z.object({ codeId: CodeIdSchema, reasons: z.array(CodeAttentionReasonSchema) }).strict()),
      })
      .strict(),
  },
  /**
   * What one owner's readable Code is, in numbers: automations of the running version, or of the newest one before it
   * runs, and the targets it holds access to, by type. For settings and for delete dialogs that say what goes along.
   */
  summary: {
    input: z.object({ owner: CodeOwnerSchema.describe("Exact Code owner.") }).strict(),
    data: z
      .object({
        items: z.array(
          z
            .object({
              codeId: CodeIdSchema,
              automations: z.number().int().nonnegative(),
              access: z.array(z.object({ type: z.string(), title: z.string(), count: z.number().int().positive() }).strict()),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /**
   * Across owners: resource or app Code that needs one of its administrators, for a person's own list. It shows the
   * same reasons as `attention`, plus a pause, and only Code the caller may edit.
   */
  list: {
    input: z.object({ cursor: CodeIdSchema.optional().describe("Last candidate Code ID returned as nextCursor.") }).strict(),
    data: z
      .object({
        items: z.array(
          z
            .object({
              code: CodeSchema,
              reasons: z.array(z.union([CodeAttentionReasonSchema, z.literal("paused")])).min(1),
              /** When the newest finished run ended; null without one. */
              lastRunAt: z.iso.datetime().nullable(),
            })
            .strict(),
        ),
        /** More candidates remain after this bounded window; follow it even when `items` is empty. */
        nextCursor: CodeIdSchema.nullable(),
      })
      .strict(),
  },
} as const;

/** Reasons are the same for every reader, so Core keeps them briefly; who may see them is checked on each request. */
export const CODE_ATTENTION_CACHE_MS = 30_000;
const CACHE_LIMIT = 1_000;
/** An owner has at most one Code; a page of 20 bounds an owner query in any case. */
const OWNER_LIMIT = 20;
/** Target apps answer slowly at worst; past this, access is simply not judged for this answer. */
export const CODE_ATTENTION_ACCESS_BUDGET_MS = 2_000;
const cache = new Map<string, { at: number; settled: boolean; reasons: Promise<CodeAttentionReason[]> }>();

const failedRun = async (code: Code) => {
  // The newest finished run of each entrypoint; skipped ticks and cancellations are not failures.
  const [row] = await sql<{ failed: boolean }[]>`SELECT EXISTS(
      SELECT 1 FROM (SELECT DISTINCT ON (entrypoint) state FROM code.runs
        WHERE code_id=${code.id} AND state IN ('succeeded','failed') ORDER BY entrypoint, created_at DESC) latest
      WHERE latest.state='failed') AS failed`;
  return row?.failed === true;
};

const pendingApproval = async (code: Code) => {
  // Mirrors the version receipt: undecided, with an unexpired pending platform approval, newer than the active version.
  const [row] = await sql<{ pending: boolean }[]>`SELECT EXISTS(
      SELECT 1 FROM code.versions v JOIN code.version_submissions s ON s.version_id=v.id
        JOIN approvals.requests r ON r.id=s.approval_id LEFT JOIN code.version_decisions d ON d.version_id=v.id
      WHERE v.code_id=${code.id} AND d.version_id IS NULL AND r.status='pending' AND r.expires_at>statement_timestamp()
        AND v.number > COALESCE((SELECT number FROM code.versions WHERE id=${code.activeVersionId}::uuid), 0)) AS pending`;
  return row?.pending === true;
};

/** At most one reconciliation per Code is in flight, also after the attention answer stopped waiting for it. */
const scans = new Map<string, ReturnType<typeof reconcileCodeAccess>>();
export const scanCodeAccess = (code: Code, context: CodeContext, reconcile = reconcileCodeAccess) => {
  let scan = scans.get(code.id);
  if (!scan) {
    scan = reconcile({ codeId: code.id }, context)
      .catch(() => [])
      .finally(() => scans.delete(code.id));
    scans.set(code.id, scan);
  }
  return scan;
};

const computeReasons = async (code: Code, context: CodeContext): Promise<CodeAttentionReason[]> => {
  // Each signal is a convenience for the owner's navigation; one that cannot be read is simply absent.
  const [failed, pending, access] = await Promise.all([
    failedRun(code).catch(() => false),
    pendingApproval(code).catch(() => false),
    // A target that cannot answer in time says nothing about access; only a confirmed removal counts.
    Promise.race([scanCodeAccess(code, context), Bun.sleep(CODE_ATTENTION_ACCESS_BUDGET_MS).then(() => [])]),
  ]);
  return [
    ...(failed ? (["run_failed"] as const) : []),
    ...(access.some((grant) => grant.state === "removed") ? (["access_missing"] as const) : []),
    ...(pending ? (["approval_pending"] as const) : []),
  ];
};

export const cachedCodeAttentionReasons = (code: Code, context: CodeContext, now = Date.now()) => {
  const hit = cache.get(code.id);
  // One computation per Code at a time: an unfinished one is shared, however old.
  if (hit && (!hit.settled || now - hit.at < CODE_ATTENTION_CACHE_MS)) return hit.reasons;
  const reasons = computeReasons(code, context);
  const entry = { at: now, settled: false, reasons };
  reasons.then(
    () => {
      entry.settled = true;
      entry.at = Date.now();
    },
    // A failed computation is not kept, so the next page asks again.
    () => {
      if (cache.get(code.id) === entry) cache.delete(code.id);
    },
  );
  cache.delete(code.id);
  cache.set(code.id, entry);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return reasons;
};

/** Readable Code of one owner and why it needs attention. Unreadable Code is never listed. */
export async function readCodeAttention(input: z.infer<typeof codeAttentionContracts.attention.input>, context: CodeContext) {
  const listed = await listCodes({ owner: input.owner, limit: OWNER_LIMIT }, context);
  const items = await Promise.all(
    listed.items
      .filter((code) => code.state !== "deleting")
      .map(async (code) => ({ codeId: code.id, reasons: await cachedCodeAttentionReasons(code, context) })),
  );
  return { items };
}

/** Candidates checked per page of the cross-owner list; each needs a live owner check. */
export const CODE_ATTENTION_CANDIDATES = 50;

/**
 * Owner Code that needs the caller, whichever owner it has. Candidates come from stored state alone, in Code ID order:
 * paused, a failed newest run of an entrypoint, or a pending approval. Each shows only when the caller may edit it, with
 * the same cached reasons as `attention`. Removed access is live, so it shows with the failed run it causes. An owner
 * that cannot answer leaves out what it cannot confirm instead of failing the list.
 */
export async function listCodeAttention(input: z.infer<typeof codeAttentionContracts.list.input>, context: CodeContext) {
  codePerson(context);
  const rows = await sql<(CodeRow & { last_run_at: Date | null })[]>`SELECT c.*,
      (SELECT max(r.ended_at) FROM code.runs r WHERE r.code_id = c.id) AS last_run_at
    FROM code.codes c
    WHERE c.owner_kind <> 'person' AND c.state <> 'deleting'
      AND (c.state = 'paused'
        OR EXISTS(SELECT 1 FROM (SELECT DISTINCT ON (entrypoint) state FROM code.runs
            WHERE code_id = c.id AND state IN ('succeeded','failed') ORDER BY entrypoint, created_at DESC) latest
          WHERE latest.state = 'failed')
        OR EXISTS(SELECT 1 FROM code.versions v JOIN code.version_submissions s ON s.version_id = v.id
            JOIN approvals.requests r ON r.id = s.approval_id LEFT JOIN code.version_decisions d ON d.version_id = v.id
          WHERE v.code_id = c.id AND d.version_id IS NULL AND r.status = 'pending' AND r.expires_at > statement_timestamp()))
      AND (${input.cursor ?? null}::text IS NULL OR c.id > ${input.cursor ?? null})
    ORDER BY c.id LIMIT ${CODE_ATTENTION_CANDIDATES + 1}`;
  const editable: { code: Code; lastRunAt: string | null }[] = [];
  for (const row of rows.slice(0, CODE_ATTENTION_CANDIDATES)) {
    const code = mapCode(row);
    const permission = await codePermission(code, context, sql, "read").catch((error: unknown) => {
      if (error instanceof CodeOwnerUnavailableError) return null;
      throw error;
    });
    if (permission === "editor") editable.push({ code, lastRunAt: row.last_run_at?.toISOString() ?? null });
  }
  const items = await Promise.all(
    editable.map(async ({ code, lastRunAt }) => ({
      code,
      lastRunAt,
      reasons: [...(code.state === "paused" ? (["paused"] as const) : []), ...(await cachedCodeAttentionReasons(code, context))],
    })),
  );
  return {
    items: items.filter((item) => item.reasons.length > 0),
    nextCursor: rows.length > CODE_ATTENTION_CANDIDATES ? rows[CODE_ATTENTION_CANDIDATES - 1]!.id : null,
  };
}

/** Test seam: forget cached reasons. */
export const clearCodeAttentionCache = () => cache.clear();

/** Numbers of one owner's Code for settings and delete dialogs; only Code the caller may read. */
export async function readCodeSummary(input: z.infer<typeof codeAttentionContracts.summary.input>, context: CodeContext) {
  const page = await listCodes({ owner: input.owner, limit: OWNER_LIMIT }, context);
  const ids = page.items.map((code) => code.id);
  if (!ids.length) return { items: [] };
  const entrypoints = await sql<{ code_id: string; automations: number }[]>`SELECT DISTINCT ON (c.id) c.id AS code_id,
      CASE WHEN jsonb_typeof(v.manifest->'entrypoints')='array' THEN jsonb_array_length(v.manifest->'entrypoints') ELSE 0 END::int AS automations
    FROM code.codes c JOIN code.versions v ON v.code_id=c.id
    WHERE c.id=ANY(${sql.array(ids, "text")})
    ORDER BY c.id, (v.id=c.active_version_id) IS TRUE DESC, v.number DESC`;
  const grants = await sql<{ code_id: string; type: string; count: number }[]>`SELECT code_id,target->>'type' AS type,count(*)::int AS count
    FROM code.target_grants WHERE code_id=ANY(${sql.array(ids, "text")}) AND state='granted' GROUP BY code_id,target->>'type'`;
  const titles = new Map<string, string>();
  for (const appId of [...new Set(grants.map((grant) => grant.type.split(".")[0] ?? ""))].filter(Boolean).slice(0, OWNER_LIMIT)) {
    const catalog = await getCapabilityCatalogApp(appId, context.locale, context.authority).catch(() => null);
    for (const type of (catalog?.ok ? catalog.data?.manifest.types : undefined) ?? []) titles.set(`${appId}.${type.localId}`, type.title);
  }
  return {
    items: ids.map((codeId) => ({
      codeId,
      automations: entrypoints.find((row) => row.code_id === codeId)?.automations ?? 0,
      access: grants
        .filter((grant) => grant.code_id === codeId)
        .map((grant) => ({ type: grant.type, title: titles.get(grant.type) ?? grant.type, count: grant.count })),
    })),
  };
}
