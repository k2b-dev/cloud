import { sql } from "@k2b/cloud";
import { draftVisibleTo, mailboxAccessPrincipalCondition } from "./access";
import type { MailRequestContext } from "./auth";

export type DraftSocketAccess = {
  doc_generation: string | number;
  doc_cursor: string | null;
  doc_history_complete: boolean;
  doc_frozen_cursor: string | null;
  state: string;
  edit_mode: string;
  author_kind: string;
};
/** Browser-session-only lease refresh. Both grant scopes, nested principals,
 * account expiry, mailbox lifecycle and assignment visibility in one snapshot.
 * Other APIs retain their permission-aware service checks.
 */
export const readDraftSocketAccess = async (
  context: MailRequestContext,
  mailboxId: string,
  draftId: string,
): Promise<DraftSocketAccess | null> => {
  if (context.actor.kind !== "user" || context.accessSubject.type !== "user") return null;
  const [row] = await sql<DraftSocketAccess[]>`
    SELECT d.doc_generation, d.doc_cursor, d.doc_history_complete, d.doc_frozen_cursor,
      d.state, d.edit_mode, d.author_kind
    FROM mail.drafts d JOIN mail.mailboxes m ON m.id=d.mailbox_id
    WHERE d.id=${draftId}::uuid AND d.mailbox_id=${mailboxId}::uuid AND d.origin='user'
      AND m.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM auth.users WHERE id=${context.actor.user.id}::uuid
        AND (account_expires IS NULL OR account_expires > now()))
      AND EXISTS (
        SELECT 1 FROM (
          SELECT access_id, false AS assigned FROM mail.mailbox_access WHERE mailbox_id=${mailboxId}::uuid
          UNION ALL
          SELECT access_id, true AS assigned FROM mail.mailbox_assigned_access WHERE mailbox_id=${mailboxId}::uuid
        ) grants JOIN auth.access a ON a.id=grants.access_id
        WHERE a.permission IN ('write', 'admin') AND ${mailboxAccessPrincipalCondition(context.accessSubject)}
          AND (NOT grants.assigned OR ${draftVisibleTo({ scope: "assigned", permission: "write", userId: context.accessSubject.userId }, sql`d`)})
      )
  `;
  return row ?? null;
};

/** Internal socket capability, never accepted from an API request. Validity is
 * checked again after the row lock and immediately before append/persistence.
 */
export type DraftSocketAuthorization = { valid(): boolean };
