import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { sql } from "bun";
import { z } from "zod";
import { type ActorRef, draftEditableContentInputSchema } from "../contracts";
import { sha256Json } from "./canonical";
import { renderComposeContent, withoutSignatureSegments } from "./compose-renderer";
import { mailboxLogoContentId } from "./mailbox-logos";
import { type OutboundDraftSnapshot, outboundDraftSnapshotSchema } from "./outbound-mime";

const internalDraftEditableContentInputSchema = draftEditableContentInputSchema.extend({
  senderIdentityId: z.string().uuid(),
  signatureTemplateId: z.string().uuid().nullable().optional(),
});
type SendSource = {
  conversation_id: string | null;
  to_addresses: unknown;
  cc_addresses: unknown;
  bcc_addresses: unknown;
  subject: string;
  body_markdown: string;
  body_format: "plain" | "markdown";
  priority: "low" | "normal" | "high";
  request_delivery_receipt: boolean;
  request_read_receipt: boolean;
  origin: "user" | "workflow";
  delivery_class: "normal" | "automatic_reply";
  revision: string | number;
  intent: "new" | "reply" | "reply_all" | "forward";
  display_name: string;
  sender_identity_id: string;
  signature_template_id: string | null;
  from_address: string;
  reply_to: string | null;
  envelope_sender: string | null;
  vcard: string | null;
  identity_transport_revision: number | null;
  identity_transport_capabilities: unknown;
  identity_transport_verified_at: Date | string | null;
  parent_message_id: string | null;
  reference_ids: string[] | null;
  attachments: unknown;
  signature: string | null;
  custom_css: string;
  mailbox_name: string;
  mailbox_description: string | null;
  actor_name: string | null;
  actor_uid: string | null;
  actor_mail: string | null;
  account_name: string | null;
  logo_id: string | null;
  logo_type: "image/png" | "image/jpeg" | null;
  logo_size: number | null;
  logo_sha256: string | null;
  logo_width: number | null;
  logo_height: number | null;
  logo_display_width: number | null;
  logo_alt: string | null;
};

/** One SQL snapshot supplies every render and MIME dependency. Only execution takes the existing draft/identity locks.
 * Review is read-only and uses the real execution actor; neither path reconstructs content under a browser identity. */
export const loadSendContent = async (params: {
  db: typeof sql;
  mailboxId: string;
  draftId: string;
  expectedRevision: number;
  senderIdentityId?: string;
  actor: ActorRef;
  lock?: boolean;
}): Promise<Result<{ snapshot: OutboundDraftSnapshot; contentHash: string; source: SendSource }>> => {
  const actorUserId =
    params.actor.kind === "user" ? params.actor.userId : params.actor.kind === "service_account" ? params.actor.delegatedUserId : null;
  const accountId = params.actor.kind === "service_account" ? params.actor.serviceAccountId : null;
  const [draft] = await params.db<SendSource[]>`
    SELECT
      d.conversation_id,
      signature.body_template AS signature, COALESCE(style.custom_css, '') AS custom_css,
      m.name AS mailbox_name, m.description AS mailbox_description,
      u.display_name AS actor_name, u.uid AS actor_uid, u.mail AS actor_mail, account.name AS account_name,
      logo.id AS logo_id, logo.content_type AS logo_type, octet_length(logo.content)::int AS logo_size,
      logo.sha256 AS logo_sha256, logo.pixel_width AS logo_width, logo.pixel_height AS logo_height,
      logo.display_width AS logo_display_width, logo.alt_text AS logo_alt,
      d.to_addresses,
      d.cc_addresses,
      d.bcc_addresses,
      d.subject,
      d.body_markdown,
      d.body_format,
      d.signature_template_id,
      d.priority,
      d.request_delivery_receipt,
      d.request_read_receipt,
      d.origin,
      d.delivery_class,
      d.revision,
      d.intent,
      si.display_name,
      si.id AS sender_identity_id,
      si.from_address,
      si.reply_to,
      si.envelope_sender,
      si.vcard,
      identity_transport.revision AS identity_transport_revision,
      identity_transport.capabilities AS identity_transport_capabilities,
      identity_transport.last_verified_at AS identity_transport_verified_at,
      CASE WHEN d.intent IN ('reply', 'reply_all') THEN source.message_id ELSE NULL END AS parent_message_id,
      CASE WHEN d.intent IN ('reply', 'reply_all') THEN source.reference_ids ELSE ARRAY[]::text[] END AS reference_ids,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', attachment.id,
              'blobId', attachment.blob_id,
              'filename', attachment.filename,
              'contentType', attachment.content_type,
              'byteLength', attachment.byte_length,
              'contentHash', attachment.content_hash
            ) ORDER BY attachment.position, attachment.id
          )
          FROM mail.draft_attachments attachment
          WHERE attachment.draft_id = d.id AND attachment.removed_at IS NULL
        ),
        '[]'::jsonb
      ) AS attachments
    FROM mail.drafts d
    JOIN mail.sender_identities si ON si.id = d.sender_identity_id AND si.mailbox_id = d.mailbox_id
    JOIN mail.mailboxes m ON m.id = d.mailbox_id AND m.deleted_at IS NULL
    LEFT JOIN mail.compose_templates signature ON signature.id = d.signature_template_id
      AND signature.mailbox_id = m.id AND signature.kind = 'signature' AND signature.archived_at IS NULL
    LEFT JOIN mail.compose_styles style ON style.mailbox_id = m.id
    LEFT JOIN mail.mailbox_logo_versions logo ON logo.id = m.logo_version_id AND logo.mailbox_id = m.id
    LEFT JOIN auth.users u ON u.id = ${actorUserId}::uuid
    LEFT JOIN auth.service_accounts account ON account.id = ${accountId}::uuid
    LEFT JOIN mail.sender_identity_transports identity_transport
      ON identity_transport.sender_identity_id = si.id
     AND identity_transport.status = 'active'
     AND identity_transport.encrypted_secret IS NOT NULL
    LEFT JOIN mail.message_contents source ON source.id = d.source_message_id
    WHERE d.id = ${params.draftId}::uuid
      AND d.mailbox_id = ${params.mailboxId}::uuid
      AND (${params.senderIdentityId ?? null}::uuid IS NULL OR d.sender_identity_id = ${params.senderIdentityId ?? null}::uuid)
      AND d.revision = ${params.expectedRevision}
      AND si.status = 'verified'
    ${params.lock ? params.db`FOR UPDATE OF d, si` : params.db``}
  `;
  if (!draft) return fail(err.badInput("Draft or sender identity is no longer available"));
  if (actorUserId && !draft.actor_uid) return fail(err.badInput("The delegated compose user is no longer available"));
  const content = internalDraftEditableContentInputSchema.safeParse({
    senderIdentityId: draft.sender_identity_id,
    signatureTemplateId: draft.signature_template_id,
    to: draft.to_addresses,
    cc: draft.cc_addresses,
    bcc: draft.bcc_addresses,
    subject: draft.subject,
    body: draft.body_markdown,
    format: draft.body_format,
    priority: draft.priority,
    requestDeliveryReceipt: draft.request_delivery_receipt,
    requestReadReceipt: draft.request_read_receipt,
  });
  if (!content.success) {
    const invalid = err.badInput(content.error.issues[0]?.message ?? "Draft content is invalid");
    return fail(invalid);
  }
  if (!content.data.to.length && !content.data.cc.length && !content.data.bcc.length)
    return fail(err.badInput("At least one recipient is required before sending"));
  const contentId = draft.logo_id ? mailboxLogoContentId(draft.logo_id, draft.from_address) : "";
  const rendered = renderComposeContent({
    body: draft.signature ? withoutSignatureSegments(content.data.body, draft.signature) : content.data.body,
    format: content.data.format,
    signature: draft.signature,
    customCss: draft.custom_css,
    renderLiquid: draft.origin === "user",
    context: {
      actor: {
        display_name: draft.actor_name || draft.actor_uid || draft.account_name || "Mailbox automation",
        email: draft.actor_mail ?? "",
      },
      mailbox: { name: draft.mailbox_name, description: draft.mailbox_description ?? "" },
      sender: { display_name: draft.display_name || draft.from_address, email: draft.from_address, reply_to: draft.reply_to ?? "" },
      message: { subject: content.data.subject, to: content.data.to.map((p) => p.address), cc: content.data.cc.map((p) => p.address) },
    },
    logo: draft.logo_id
      ? {
          src: `cid:${contentId}`,
          altText: draft.logo_alt ?? "",
          displayWidth: draft.logo_display_width!,
          pixelWidth: draft.logo_width!,
          pixelHeight: draft.logo_height!,
          byteLength: draft.logo_size!,
        }
      : null,
  });
  if (!rendered.ok) return rendered;
  const inlineLogo =
    draft.logo_id && rendered.data.html && rendered.data.logoUsed
      ? {
          versionId: draft.logo_id,
          sha256: draft.logo_sha256!,
          contentType: draft.logo_type!,
          byteLength: draft.logo_size!,
          contentId,
        }
      : null;
  const references = [...(draft.reference_ids ?? []), ...(draft.parent_message_id ? [draft.parent_message_id] : [])].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
  const snapshot = outboundDraftSnapshotSchema.safeParse({
    revision: Number(draft.revision),
    from: { name: draft.display_name, address: draft.from_address },
    replyTo: draft.reply_to,
    envelopeFrom: draft.envelope_sender,
    useNullEnvelopeSender: draft.delivery_class === "automatic_reply",
    automaticReply: draft.delivery_class === "automatic_reply",
    priority: draft.priority,
    requestDeliveryReceipt: draft.request_delivery_receipt,
    requestReadReceipt: draft.request_read_receipt,
    receiptAddress: draft.from_address,
    vcard: draft.vcard,
    to: draft.to_addresses,
    cc: draft.cc_addresses,
    bcc: draft.bcc_addresses,
    subject: draft.subject,
    body: draft.body_markdown,
    format: draft.body_format,
    renderedText: rendered.data.text,
    renderedHtml: rendered.data.html,
    inlineLogo: inlineLogo,
    inReplyTo: draft.parent_message_id,
    references,
    attachments: draft.attachments,
  });
  if (!snapshot.success) {
    const message = snapshot.error.issues[0]?.message ?? "Rendered message is too large";
    return fail(err.badInput(message));
  }
  return ok({ snapshot: snapshot.data, contentHash: sha256Json(snapshot.data), source: draft });
};

export const sendContentChanged = () => ({
  code: "SEND_CONTENT_CHANGED",
  status: 409 as const,
  message: "The message content changed. Nothing was queued. Open the draft, check it again and approve a new send attempt.",
});
