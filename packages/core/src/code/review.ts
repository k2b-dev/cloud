import { redis, sql } from "@k2b/cloud";
import { APP_APPROVAL_LIMITS } from "@k2b/cloud/contracts";
import { approvalDecisionHints } from "@k2b/cloud/services/approvals";
import type { z } from "zod";
import { type CodeContext, CodeDataError, codePermission, codePerson } from "./access";
import { readCodeReviewComments } from "./review-comments";
import {
  type CodeReview,
  CodeReviewInputSchema,
  CodeReviewRevisionSchema,
  CodeReviewWaitInputSchema,
  CodeSubmissionOriginSchema,
  codeReviewFollowUp,
} from "./review-contracts";
import { findCode } from "./store";

/** Review messages are published by a decision, with anchors only for current editors. */
export async function readCodeReview(
  raw: z.input<typeof CodeReviewInputSchema>,
  context: CodeContext,
  options: { anchors?: boolean; decidedOnly?: boolean } = {},
): Promise<CodeReview> {
  const input = CodeReviewInputSchema.parse(raw);
  codePerson(context);
  const code = await findCode(input.codeId);
  if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
  if ((await codePermission(code, context, sql, "edit")) !== "editor") throw new CodeDataError("NOT_FOUND", "Code not found.");
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const [row] = await tx<
      {
        number: number;
        active_id: string | null;
        active_number: number | null;
        approval_id: string | null;
        origin: unknown;
        status: string | null;
        expires_at: Date | null;
        unexpired: boolean | null;
        withdrawn: boolean;
        outcome: "approved" | "changes_requested" | "rejected" | null;
        comment: string | null;
        decided_by: string | null;
        decided_at: Date | null;
        name: string | null;
        avatar_hash: string | null;
      }[]
    >`SELECT v.number,s.approval_id,s.origin,r.status,r.expires_at,(r.expires_at>now()) AS unexpired,
      EXISTS(SELECT 1 FROM code.version_withdrawals w WHERE w.version_id=v.id) AS withdrawn,
      d.outcome,d.comment,d.decided_by,d.decided_at,COALESCE(NULLIF(u.display_name,''),u.uid) AS name,u.avatar_hash,
      a.id AS active_id,a.number AS active_number
      FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id JOIN code.codes c ON c.id=s.code_id
      LEFT JOIN code.versions a ON a.id=c.active_version_id LEFT JOIN approvals.requests r ON r.id=s.approval_id
      LEFT JOIN code.version_decisions d ON d.version_id=v.id LEFT JOIN auth.users u ON u.id=d.decided_by
      WHERE s.code_id=${input.codeId} AND s.version_id=${input.versionId}::uuid`;
    if (!row) throw new CodeDataError("NOT_FOUND", "Code review not found.");
    if (options.decidedOnly && !row.outcome) throw new CodeDataError("CONFLICT", "The review has not been published by a decision.");
    const page = row.outcome
      ? await readCodeReviewComments({ ...input, limit: 20 }, options.anchors !== false, tx)
      : { items: [], nextBefore: null, total: 0 };
    const [revision] = await tx<
      {
        state: string;
        reason: string | null;
        turn_id: string | null;
        submitted_version_id: string | null;
        submitted_number: number | null;
      }[]
    >`SELECT w.*,v.number AS submitted_number FROM code.review_chat_work w
      LEFT JOIN code.versions v ON v.id=w.submitted_version_id WHERE w.version_id=${input.versionId}::uuid`;
    return {
      codeId: input.codeId,
      versionId: input.versionId,
      number: row.number,
      status: row.withdrawn
        ? "withdrawn"
        : (row.outcome ??
          (!row.approval_id
            ? "not_required"
            : row.status === "pending" && row.unexpired
              ? "pending"
              : row.status === "cancelled"
                ? "superseded"
                : "expired")),
      origin: CodeSubmissionOriginSchema.parse(row.origin),
      changesRequestedEffect: codeReviewFollowUp(CodeSubmissionOriginSchema.parse(row.origin), context.locale ?? "en"),
      approvalId: row.approval_id,
      expiresAt: row.expires_at?.toISOString() ?? null,
      decidedBy: row.decided_at ? { id: row.decided_by, name: row.name, avatarHash: row.avatar_hash } : null,
      decidedAt: row.decided_at?.toISOString() ?? null,
      message: row.comment,
      comments: page.items,
      nextBefore: page.nextBefore,
      commentCount: page.total,
      activeVersion: row.active_id && row.active_number ? { id: row.active_id, number: row.active_number } : null,
      contentTrust: "untrusted_data",
      revision: revision
        ? CodeReviewRevisionSchema.parse({
            state: revision.state,
            reason: revision.reason,
            turnId: revision.turn_id,
            submittedVersionId: revision.submitted_version_id,
            submittedNumber: revision.submitted_number,
          })
        : null,
    };
  });
}

/** One held request per person across replicas. Other requests return their snapshot immediately.
 * The login polling interval is both the hold budget and the abandoned-lease expiry.
 */
export async function waitCodeReview(input: z.input<typeof CodeReviewInputSchema> & { holdMs: number }, context: CodeContext) {
  const { holdMs: requestedHoldMs, ...reviewInput } = CodeReviewWaitInputSchema.parse(input);
  const user = codePerson(context);
  const lease = `core:code-review-wait:${user.id}`;
  const token = crypto.randomUUID();
  const holdMs = Math.max(0, Math.min(requestedHoldMs, APP_APPROVAL_LIMITS.pollSeconds * 1000));
  const first = await readCodeReview(reviewInput, context);
  if (!holdMs || first.status !== "pending" || !first.approvalId) return first;
  const acquired = await redis.send("SET", [lease, token, "NX", "PX", String(holdMs + 1000)]);
  if (acquired !== "OK") return first;
  const controller = new AbortController();
  const stop = () => controller.abort();
  const ended = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  context.signal?.addEventListener("abort", stop, { once: true });
  if (context.signal?.aborted) stop();
  // Listen, then read again. Like browserStatus, live() has no subscription-ready
  // barrier: hints are best effort; the deadline read covers lost wake-ups.
  const hint = approvalDecisionHints.wait(first.approvalId, controller.signal).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = await readCodeReview(reviewInput, context);
    if (current.status !== "pending") return current;
    timer = setTimeout(stop, Math.min(holdMs, Math.max(0, Date.parse(current.expiresAt!) - Date.now())));
    await Promise.race([hint, ended]);
    context.signal?.throwIfAborted();
    return await readCodeReview(reviewInput, context);
  } finally {
    clearTimeout(timer);
    stop();
    context.signal?.removeEventListener("abort", stop);
    await redis.send("EVAL", [
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      "1",
      lease,
      token,
    ]);
  }
}
