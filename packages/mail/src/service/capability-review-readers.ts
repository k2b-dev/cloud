/** Reads used only by Assistant/MCP reviews. No writes, provider calls or queue work. */
import type { CapabilityPerson } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { type DraftPreviewSource, reviewPerson } from "../capability-reviews";
import type { MailDraft } from "../contracts";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { renderComposeContent, withoutSignatureSegments } from "./compose-renderer";
import { mailboxLogoContentId } from "./mailbox-logos";

type SendParts = {
  origin: "user" | "workflow";
  raw_body: string;
  display_name: string;
  from_address: string;
  vcard: string | null;
  reply_to: string | null;
  mailbox_name: string;
  mailbox_description: string | null;
  signature: string | null;
  custom_css: string;
  actor_name: string | null;
  actor_uid: string | null;
  actor_mail: string | null;
  account_name: string | null;
  logo_id: string | null;
  logo_type: "image/png" | "image/jpeg" | null;
  logo_size: number | null;
  logo_width: number | null;
  logo_height: number | null;
  logo_display_width: number | null;
  logo_alt: string | null;
};
/** One extra lookup supplies render inputs and generated MIME-part metadata from the
 * same sources as createSendOutbox/renderComposeDraft. Reuse the actual renderer;
 * identity defaults and calendar attendees are materialized before send, never added here.
 */
export const loadSendReviewContent = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draft: MailDraft;
  senderIdentityId: string;
}): Promise<Result<{ draft: DraftPreviewSource; from: CapabilityPerson; contentHash: string }>> => {
  const actor = actorRefFromRequest(params.context);
  const actorUserId = actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.delegatedUserId : null;
  const accountId = actor.kind === "service_account" ? actor.serviceAccountId : null;
  if (params.draft.senderIdentityId !== params.senderIdentityId || params.draft.state !== "draft")
    return fail(err.badInput("Draft or sender identity is not ready for sending"));
  if (!params.draft.to.length && !params.draft.cc.length && !params.draft.bcc.length)
    return fail(err.badInput("At least one recipient is required before sending"));
  const [parts] = await sql<SendParts[]>`
    SELECT d.origin, d.body_markdown AS raw_body, si.display_name, si.from_address, si.reply_to, si.vcard,
      m.name AS mailbox_name, m.description AS mailbox_description,
      signature.body_template AS signature, COALESCE(style.custom_css, '') AS custom_css,
      u.display_name AS actor_name, u.uid AS actor_uid, u.mail AS actor_mail, account.name AS account_name,
      logo.id AS logo_id, logo.content_type AS logo_type, octet_length(logo.content)::int AS logo_size,
      logo.pixel_width AS logo_width, logo.pixel_height AS logo_height,
      logo.display_width AS logo_display_width, logo.alt_text AS logo_alt
    FROM mail.mailboxes m
    JOIN mail.drafts d ON d.mailbox_id = m.id AND d.id = ${params.draft.id}::uuid AND d.revision = ${params.draft.revision}
    JOIN mail.sender_identities si ON si.id = d.sender_identity_id AND si.mailbox_id = m.id AND si.id = ${params.senderIdentityId}::uuid AND si.status = 'verified'
    LEFT JOIN mail.compose_templates signature ON signature.id = d.signature_template_id
      AND signature.mailbox_id = m.id AND signature.kind = 'signature' AND signature.archived_at IS NULL
    LEFT JOIN mail.compose_styles style ON style.mailbox_id = m.id
    LEFT JOIN mail.mailbox_logo_versions logo ON logo.id = m.logo_version_id AND logo.mailbox_id = m.id
    LEFT JOIN auth.users u ON u.id = ${actorUserId}::uuid
    LEFT JOIN auth.service_accounts account ON account.id = ${accountId}::uuid
    WHERE m.id = ${params.mailboxId}::uuid AND m.deleted_at IS NULL
  `;
  if (!parts) return fail(err.badInput("Draft or sender identity is not ready for sending"));
  if (actorUserId && !parts.actor_uid) return fail(err.badInput("The delegated compose user is no longer available"));
  const d = params.draft;
  const rendered = renderComposeContent({
    body: parts.signature ? withoutSignatureSegments(parts.raw_body, parts.signature) : parts.raw_body,
    format: d.format,
    signature: parts.signature,
    customCss: parts.custom_css,
    renderLiquid: parts.origin === "user",
    context: {
      actor: {
        display_name: parts.actor_name || parts.actor_uid || parts.account_name || "Mailbox automation",
        email: parts.actor_mail ?? "",
      },
      mailbox: { name: parts.mailbox_name, description: parts.mailbox_description ?? "" },
      sender: { display_name: parts.display_name || parts.from_address, email: parts.from_address, reply_to: parts.reply_to ?? "" },
      message: { subject: d.subject, to: d.to.map((p) => p.address), cc: d.cc.map((p) => p.address) },
    },
    logo: parts.logo_id
      ? {
          src: `cid:${mailboxLogoContentId(parts.logo_id, parts.from_address)}`,
          altText: parts.logo_alt ?? "",
          displayWidth: parts.logo_display_width!,
          pixelWidth: parts.logo_width!,
          pixelHeight: parts.logo_height!,
          byteLength: parts.logo_size!,
        }
      : null,
  });
  if (!rendered.ok) return rendered;
  const attachments: DraftPreviewSource["attachments"] = d.attachments.map((a) => ({ filename: a.filename, byteLength: a.byteLength }));
  if (d.format === "markdown" && parts.logo_id && rendered.data.html && rendered.data.logoUsed)
    attachments.push({ filename: parts.logo_type === "image/png" ? "logo.png" : "logo.jpg", byteLength: parts.logo_size! });
  if (parts.vcard) attachments.push({ filename: "contact.vcf", byteLength: Buffer.byteLength(parts.vcard) });
  // rendered.text is the MIME text alternative, including the resolved signature and HTML-to-text conversion.
  return ok({
    // Bind the full effective message, including time-dependent Liquid output and
    // generated MIME parts. Unused actor metadata must not invalidate the same message.
    contentHash: sha256Json({
      draft: d,
      rendered: rendered.data,
      from: { name: parts.display_name, address: parts.from_address, replyTo: parts.reply_to },
      vcard: parts.vcard,
      logoVersion: parts.logo_id,
    }),
    from: reviewPerson({ name: parts.display_name, address: parts.from_address }),
    draft: { ...d, body: rendered.data.text, format: "plain", attachments },
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
