import type { SQL } from "bun";
import { parseStoredReviewContent } from "../../capabilities/review-storage";
import { CAPABILITY_MAX_REVIEW_CONTENT_BYTES } from "../../contracts/capabilities";
import { sql } from "../../runtime/clients";
import { type ApprovalRoleContext, hasApprovalRoleAccess } from "./authority";

// Chat runtime readers deliberately keep the personal, pending-action-only contract.
export const openRequests = (approverUserId: string, id?: string) => sql`SELECT r.* FROM approvals.requests r
  WHERE r.approver_user_id=${approverUserId}::uuid AND r.status='pending' AND r.expires_at > now()
    AND r.approver_auth_epoch=(SELECT auth_epoch FROM auth.users WHERE id=${approverUserId}::uuid)
    AND (${id ?? null}::uuid IS NULL OR r.id=${id ?? null}::uuid)
    AND EXISTS (SELECT 1 FROM ai.pending_actions p WHERE p.approval_id=r.id AND p.status='pending')`;

/** Open personal Actions retain their chat wait; role requests have their own lifecycle. */
export const openRecipientRequests = async (
  approverUserId: string,
  id: string | undefined,
  roleContext: ApprovalRoleContext | undefined,
  db: SQL,
) => {
  const admin = await hasApprovalRoleAccess(approverUserId, roleContext, db);
  return {
    admin,
    query: sql`SELECT r.* FROM approvals.requests r
    WHERE r.status='pending' AND r.expires_at > now()
      AND (${id ?? null}::uuid IS NULL OR r.id=${id ?? null}::uuid)
      AND ((r.kind='action' AND r.approver_user_id=${approverUserId}::uuid
        AND r.approver_auth_epoch=(SELECT auth_epoch FROM auth.users WHERE id=${approverUserId}::uuid)
        AND EXISTS (SELECT 1 FROM ai.pending_actions p WHERE p.approval_id=r.id AND p.status='pending'))
        OR (r.kind='code_version' AND r.approver_role='admin' AND ${admin}))`,
  };
};

/** Keep the original approval's digest and reader even when the turn has moved to a newer question. */
export const compactApprovalDetailsSql = (row = "r") => {
  const details = sql`${sql(`${row}.details`)}`;
  return sql`CASE WHEN jsonb_typeof(${details}) = 'object' THEN (${details} - 'content') || CASE WHEN ${details} ? 'content' THEN jsonb_build_object(
    'contentRef', jsonb_build_object('href', '/api/approvals/' || ${sql(`${row}.id`)}::text || '/content', 'digest', ${sql(`${row}.review_digest`)})
  ) ELSE '{}'::jsonb END ELSE ${details} END`;
};

/** Read one complete snapshot under the current personal or Cloud-admin recipient policy. */
export const readApprovalContent = async (input: {
  id: string;
  approverUserId: string;
  digest: string;
  signal?: AbortSignal;
  roleContext?: ApprovalRoleContext;
}) =>
  sql.begin(async (tx) => {
    input.signal?.throwIfAborted();
    const open = await openRecipientRequests(input.approverUserId, input.id, input.roleContext, tx);
    const query = tx<{ content: unknown }[]>`
    SELECT r.details->'content' AS content FROM (${open.query}) r
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
  });
