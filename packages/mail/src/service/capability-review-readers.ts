/** Reads used only by Assistant/MCP reviews. No writes, provider calls or queue work. */
import type { CapabilityPerson } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { DraftPreviewSource } from "../capability-reviews";
import type { MailDraft } from "../contracts";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { loadSendContent } from "./send-content";

/** Shared render snapshot, under the caller's execution identity. Authorization is checked by the owning service. */
export const loadSendReviewContent = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draft: MailDraft;
  senderIdentityId: string;
}): Promise<Result<{ draft: DraftPreviewSource; from: CapabilityPerson; contentHash: string }>> => {
  if (params.draft.state !== "draft") return fail(err.badInput("Draft is not ready for sending"));
  const loaded = await loadSendContent({
    db: sql,
    mailboxId: params.mailboxId,
    draftId: params.draft.id,
    expectedRevision: params.draft.revision,
    senderIdentityId: params.senderIdentityId,
    actor: actorRefFromRequest(params.context),
  });
  if (!loaded.ok) return loaded;
  const snapshot = loaded.data.snapshot;
  const attachments: DraftPreviewSource["attachments"] = snapshot.attachments.map((a) => ({
    filename: a.filename,
    byteLength: a.byteLength,
  }));
  if (snapshot.inlineLogo)
    attachments.push({
      filename: snapshot.inlineLogo.contentType === "image/png" ? "logo.png" : "logo.jpg",
      byteLength: snapshot.inlineLogo.byteLength,
    });
  if (snapshot.vcard) attachments.push({ filename: "contact.vcf", byteLength: Buffer.byteLength(snapshot.vcard) });
  return ok({
    contentHash: loaded.data.contentHash,
    from: snapshot.from,
    draft: { ...snapshot, body: snapshot.renderedText!, format: "plain", attachments },
  });
};

export type AssignmentReviewChange = {
  requested: CapabilityPerson[];
  added: CapabilityPerson[];
  removed: CapabilityPerson[];
  addedTotal: number;
  removedTotal: number;
};
/** One bounded response for up to 50 conversations, including nested-group grants.
 * Only removals that actually end assigned-only access are reported as removed.
 */
export const loadAssignmentReviewChange = async (params: {
  mailboxId: string;
  conversationIds: readonly string[];
  assigneeUserIds: readonly string[];
  mode: "add" | "remove" | "replace";
  actorUserId: string | null;
}): Promise<AssignmentReviewChange> => {
  const [row] = await sql<
    { requested: CapabilityPerson[]; added: CapabilityPerson[]; removed: CapabilityPerson[]; added_total: number; removed_total: number }[]
  >`
    WITH RECURSIVE requested AS (
      SELECT id FROM mail.conversations WHERE mailbox_id = ${params.mailboxId}::uuid
        AND short_id IN (SELECT value FROM jsonb_array_elements_text(${params.conversationIds}::jsonb))
    ), changes AS (
      SELECT DISTINCT u.id AS user_id, u.display_name, u.uid, u.mail,
        ${params.mode !== "remove"} AND u.id <> COALESCE(${params.actorUserId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND u.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${params.assigneeUserIds}::jsonb))
          AND EXISTS (SELECT 1 FROM requested c WHERE NOT EXISTS (SELECT 1 FROM mail.conversation_assignees ca WHERE ca.conversation_id = c.id AND ca.user_id = u.id)) AS added,
        ${params.mode !== "add"} AND EXISTS (SELECT 1 FROM mail.conversation_assignees ca JOIN requested c ON c.id = ca.conversation_id WHERE ca.user_id = u.id)
          AND CASE WHEN ${params.mode === "remove"} THEN u.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${params.assigneeUserIds}::jsonb))
            ELSE u.id NOT IN (SELECT value::uuid FROM jsonb_array_elements_text(${params.assigneeUserIds}::jsonb)) END AS removed
      FROM auth.users u WHERE u.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${params.assigneeUserIds}::jsonb))
        OR u.id IN (SELECT ca.user_id FROM mail.conversation_assignees ca JOIN requested c ON c.id = ca.conversation_id)
    ), memberships(user_id, group_id) AS (
      SELECT ug.user_id, ug.group_id FROM auth.user_groups_v2 ug JOIN changes c ON c.user_id = ug.user_id
      UNION SELECT m.user_id, gg.parent_group_id FROM memberships m JOIN auth.group_groups_v2 gg ON gg.child_group_id = m.group_id
    ), grants AS (
      SELECT c.*, EXISTS (
        SELECT 1 FROM mail.mailbox_access ma JOIN auth.access a ON a.id = ma.access_id
        WHERE ma.mailbox_id = ${params.mailboxId}::uuid AND a.permission IN ('read','write','admin') AND
          (a.user_id = c.user_id OR a.group_id IN (SELECT group_id FROM memberships WHERE user_id = c.user_id)
            OR a.authenticated_only OR (a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL))
      ) AS full_access, EXISTS (
        SELECT 1 FROM mail.mailbox_assigned_access ma JOIN auth.access a ON a.id = ma.access_id
        WHERE ma.mailbox_id = ${params.mailboxId}::uuid AND a.permission IN ('read','write','admin') AND
          (a.user_id = c.user_id OR a.group_id IN (SELECT group_id FROM memberships WHERE user_id = c.user_id))
      ) AS assigned_access FROM changes c
    ), added AS (SELECT * FROM grants WHERE added ORDER BY user_id),
    removed AS (SELECT * FROM grants WHERE removed AND assigned_access AND NOT full_access ORDER BY user_id)
    SELECT
      COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', COALESCE(NULLIF(display_name,''), uid), 'userId', id, 'address', NULLIF(mail,''))) ORDER BY requested.ordinality)
        FROM jsonb_array_elements_text(${params.assigneeUserIds}::jsonb) WITH ORDINALITY requested(value, ordinality)
        JOIN auth.users ON id = requested.value::uuid), '[]'::jsonb) AS requested,
      COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', COALESCE(NULLIF(display_name,''), uid), 'userId', user_id, 'address', NULLIF(mail,'')))) FROM (SELECT * FROM added LIMIT 20) a), '[]'::jsonb) AS added,
      COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', COALESCE(NULLIF(display_name,''), uid), 'userId', user_id, 'address', NULLIF(mail,'')))) FROM (SELECT * FROM removed LIMIT 20) r), '[]'::jsonb) AS removed,
      (SELECT count(*)::int FROM added) AS added_total, (SELECT count(*)::int FROM removed) AS removed_total
  `;
  return {
    requested: row?.requested ?? [],
    added: row?.added ?? [],
    removed: row?.removed ?? [],
    addedTotal: row?.added_total ?? 0,
    removedTotal: row?.removed_total ?? 0,
  };
};

export type SendSubmissionState =
  | "scheduled"
  | "undo_window"
  | "sending"
  | "accepted"
  | "sent_sync_pending"
  | "sent"
  | "failed"
  | "cancelled"
  | "unknown"
  | "reconciled_accepted"
  | "reconciled_unsent"
  | "needs_attention";

/** Command, outbox and draft state are written in the same send transaction.
 * No command-only interval exists. The draft index bounds this to its own submissions.
 */
export const loadDraftSendOutcome = async (
  mailboxId: string,
  draft: Pick<MailDraft, "id" | "state" | "revision">,
  revision: number,
): Promise<{ state: SendSubmissionState; scheduledAt: string | null } | null> => {
  // Future revisions have never sent. At the same revision, draft is unsent/failed;
  // discarded is cancel+discard. Neither has an in-flight send.
  if (revision > draft.revision || (revision === draft.revision && (draft.state === "draft" || draft.state === "discarded"))) return null;
  // Queue/schedule -> scheduled, dispatch -> sending; failure -> draft, same revision.
  // Cancel+restore -> draft, revision+1; cancel+discard -> discarded, same revision.
  // Unknown/needs_attention and sent -> sent, same revision: read the delivery to distinguish.
  const [row] = await sql<{ state: SendSubmissionState; scheduled_at: Date | string | null }[]>`
    SELECT o.state, o.requested_at AS scheduled_at
    FROM mail.outbox_submissions o JOIN mail.commands c ON c.id = o.command_id
    WHERE o.draft_id = ${draft.id}::uuid AND o.mailbox_id = ${mailboxId}::uuid AND c.kind = 'send'
      AND c.target ->> 'expectedDraftRevision' = ${String(revision)}
    ORDER BY o.created_at DESC LIMIT 1
  `;
  return row
    ? { state: row.state, scheduledAt: row.scheduled_at instanceof Date ? row.scheduled_at.toISOString() : row.scheduled_at }
    : null;
};
export const draftSendOutcome = (state: SendSubmissionState | undefined): "done" | "not_done" | "pending" => {
  switch (state) {
    case "scheduled":
    case "undo_window":
    case "sending":
    case "accepted":
    case "sent_sync_pending":
    case "sent":
    case "reconciled_accepted":
      return "done";
    case "failed":
    case "cancelled":
    case "reconciled_unsent":
    case undefined:
      return "not_done";
    case "unknown":
    case "needs_attention":
      return "pending";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};
