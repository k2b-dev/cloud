import { sql } from "@k2b/cloud";
import { z } from "zod";
import { type CodeContext, CodeOwnerUnavailableError, codePermission, codePerson } from "./access";
import { type Code, CodeIdSchema, CodeOwnerSchema, CodeSchema } from "./contracts";
import { type CodeRow, listCodes, mapCode } from "./store";

/** Why an owner's Code needs someone: its newest run of an entrypoint failed, a call was refused by its target, or a version waits for approval. */
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
   * runs, and an empty legacy access summary. For settings and for delete dialogs that say what goes along.
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

const computeReasons = async (code: Code, _context: CodeContext): Promise<CodeAttentionReason[]> => {
  const [failed, pending, refusal] = await Promise.all([
    failedRun(code).catch(() => false),
    pendingApproval(code).catch(() => false),
    sql<{ refused: boolean }[]>`SELECT EXISTS(
      SELECT 1 FROM (SELECT DISTINCT ON (entrypoint) state,first_refused_call_ordinal FROM code.runs
        WHERE code_id=${code.id} AND state IN ('succeeded','failed') ORDER BY entrypoint,created_at DESC) latest
      WHERE state='failed' AND first_refused_call_ordinal IS NOT NULL) AS refused`.catch(() => []),
  ]);
  return [
    ...(failed ? (["run_failed"] as const) : []),
    ...(refusal[0]?.refused ? (["access_missing"] as const) : []),
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
 * the same cached reasons as `attention`. Missing access is reported from the latest finished run of each entrypoint. An owner
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
  return {
    items: ids.map((codeId) => ({
      codeId,
      automations: entrypoints.find((row) => row.code_id === codeId)?.automations ?? 0,
      access: [],
    })),
  };
}
