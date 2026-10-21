import { sql } from "bun";
import { parseStoredReviewContent } from "../../capabilities/review-storage";
import { CAPABILITY_MAX_REVIEW_CONTENT_BYTES } from "../../contracts/capabilities";

// Start with this person's indexed pending rows; a Studio page alone cannot continue a chat.
export const openRequests = (approverUserId: string, id?: string) => sql`SELECT r.* FROM approvals.requests r
  WHERE r.approver_user_id=${approverUserId}::uuid AND r.status='pending' AND r.expires_at > now()
    AND r.approver_auth_epoch=(SELECT auth_epoch FROM auth.users WHERE id=${approverUserId}::uuid)
    AND (${id ?? null}::uuid IS NULL OR r.id=${id ?? null}::uuid)
    AND EXISTS (SELECT 1 FROM ai.pending_actions p WHERE p.approval_id=r.id AND p.status='pending')`;

/** Keep the original approval's digest and reader even when the turn has moved to a newer question. */
export const compactApprovalDetailsSql = (row = "r") => {
  const details = sql`${sql(`${row}.details`)}`;
  return sql`CASE WHEN jsonb_typeof(${details}) = 'object' THEN (${details} - 'content') || CASE WHEN ${details} ? 'content' THEN jsonb_build_object(
    'contentRef', jsonb_build_object('href', '/api/approvals/' || ${sql(`${row}.id`)}::text || '/content', 'digest', ${sql(`${row}.review_digest`)})
  ) ELSE '{}'::jsonb END ELSE ${details} END`;
};

/** Open requests retain the existing approver, pending-action, expiry and sign-out-epoch requirements. */
export const readApprovalContent = async (input: { id: string; approverUserId: string; digest: string; signal?: AbortSignal }) => {
  input.signal?.throwIfAborted();
  const query = sql<{ content: unknown }[]>`
    SELECT r.details->'content' AS content FROM (${openRequests(input.approverUserId, input.id)}) r
    WHERE r.review_digest=${input.digest}
      AND octet_length((r.details->'content')::text) <= ${2 * CAPABILITY_MAX_REVIEW_CONTENT_BYTES + 2} LIMIT 1`;
  const abort = () => query.cancel();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  let rows: { content: unknown }[];
  try {
    rows = await query;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
  input.signal?.throwIfAborted();
  const row = rows[0];
  const parsed = parseStoredReviewContent(row?.content);
  return parsed.success ? parsed.data : null;
};
