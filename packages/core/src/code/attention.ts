import { sql } from "@k2b/cloud";
import { z } from "zod";
import type { CodeContext } from "./access";
import { reconcileCodeAccess } from "./activation-maintenance";
import { type Code, CodeIdSchema, CodeOwnerSchema } from "./contracts";
import { listCodes } from "./store";

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
} as const;

/** Reasons are the same for every reader, so Core keeps them briefly; who may see them is checked on each request. */
export const CODE_ATTENTION_CACHE_MS = 30_000;
const CACHE_LIMIT = 1_000;
/** An owner has at most one Code; a page of 20 bounds an owner query in any case. */
const OWNER_LIMIT = 20;
const cache = new Map<string, { at: number; reasons: Promise<CodeAttentionReason[]> }>();

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

const computeReasons = async (code: Code, context: CodeContext): Promise<CodeAttentionReason[]> => {
  // Each signal is a convenience for the owner's navigation; one that cannot be read is simply absent.
  const [failed, pending, access] = await Promise.all([
    failedRun(code).catch(() => false),
    pendingApproval(code).catch(() => false),
    // A target that cannot answer right now says nothing about access; only a confirmed removal counts.
    reconcileCodeAccess({ codeId: code.id }, context).catch(() => []),
  ]);
  return [
    ...(failed ? (["run_failed"] as const) : []),
    ...(access.some((grant) => grant.state === "removed") ? (["access_missing"] as const) : []),
    ...(pending ? (["approval_pending"] as const) : []),
  ];
};

const cachedReasons = (code: Code, context: CodeContext, now = Date.now()) => {
  const hit = cache.get(code.id);
  if (hit && now - hit.at < CODE_ATTENTION_CACHE_MS) return hit.reasons;
  const reasons = computeReasons(code, context);
  // A failed computation is not kept, so the next page asks again.
  reasons.catch(() => cache.delete(code.id));
  cache.delete(code.id);
  cache.set(code.id, { at: now, reasons });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return reasons;
};

/** Readable Code of one owner and why it needs attention. Unreadable Code is never listed. */
export async function readCodeAttention(input: z.infer<typeof codeAttentionContracts.attention.input>, context: CodeContext) {
  const listed = await listCodes({ owner: input.owner, limit: OWNER_LIMIT }, context);
  const items = await Promise.all(
    listed.items
      .filter((code) => code.state !== "deleting")
      .map(async (code) => ({ codeId: code.id, reasons: await cachedReasons(code, context) })),
  );
  return { items };
}

/** Test seam: forget cached reasons. */
export const clearCodeAttentionCache = () => cache.clear();
