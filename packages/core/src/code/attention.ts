import { sql } from "@k2b/cloud";
import { type CodeContext, CodeOwnerUnavailableError, codePermission, codePerson } from "./access";
import { reconcileCodeAccess } from "./activation-maintenance";
import { type CodeActivationTransport, codeActivationTransport } from "./activation-transport";
import type { Code } from "./contracts";
import { type CodeRow, mapCode } from "./store";

/** Candidates checked per page; each needs a live owner check, so the window stays small and the caller pages on. */
export const CODE_ATTENTION_CANDIDATES = 50;
type AttentionRow = CodeRow & { run_failed: boolean; last_run_at: Date | null };
export type CodeAttentionReason = "paused" | "run_failed" | "access_removed";

/**
 * Owner Code that needs its administrators: paused, or its newest finished run failed. Candidates come from state
 * alone, in Code ID order; each shows only when the caller may edit it. A failed Code also says whether a target
 * removed its access, read live like the Code page does. An owner or target app that cannot answer leaves out what
 * it cannot confirm instead of failing the list.
 */
export const listCodeAttention = async (
  input: { cursor?: string },
  context: CodeContext,
  transport: CodeActivationTransport = codeActivationTransport,
) => {
  codePerson(context);
  const rows = await sql<AttentionRow[]>`SELECT c.*, COALESCE(last.state = 'failed', false) AS run_failed, last.ended_at AS last_run_at
    FROM code.codes c
    LEFT JOIN LATERAL (SELECT r.state, r.ended_at FROM code.runs r WHERE r.code_id = c.id AND r.ended_at IS NOT NULL
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1) last ON true
    WHERE c.owner_kind <> 'person' AND c.state <> 'deleting' AND (c.state = 'paused' OR last.state = 'failed')
      AND (${input.cursor ?? null}::text IS NULL OR c.id > ${input.cursor ?? null})
    ORDER BY c.id LIMIT ${CODE_ATTENTION_CANDIDATES + 1}`;
  const items: { code: Code; reasons: CodeAttentionReason[]; lastRunAt: string | null }[] = [];
  for (const row of rows.slice(0, CODE_ATTENTION_CANDIDATES)) {
    const code = mapCode(row);
    const permission = await codePermission(code, context, sql, "read").catch((error: unknown) => {
      if (error instanceof CodeOwnerUnavailableError) return null;
      throw error;
    });
    if (permission !== "editor") continue;
    const accessRemoved = row.run_failed
      ? await reconcileCodeAccess({ codeId: code.id }, context, transport)
          .then((access) => access.some((target) => target.state === "removed"))
          .catch(() => false)
      : false;
    const reasons: CodeAttentionReason[] = [
      ...(code.state === "paused" ? (["paused"] as const) : []),
      ...(row.run_failed ? (["run_failed"] as const) : []),
      ...(accessRemoved ? (["access_removed"] as const) : []),
    ];
    items.push({ code, reasons, lastRunAt: row.last_run_at?.toISOString() ?? null });
  }
  return { items, nextCursor: rows.length > CODE_ATTENTION_CANDIDATES ? rows[CODE_ATTENTION_CANDIDATES - 1]!.id : null };
};
