import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { sql } from "bun";
import {
  type DraftEditableContent,
  draftEditableContentInputSchema,
  type MailAddress,
  type MailComposeFormat,
  type MailPriority,
} from "../contracts";
import type { MailRequestContext } from "./auth";
import { moveSignatureSegment, withoutSignatureSegments } from "./compose-renderer";
import { requireSelectableSignature, selectableSignatures } from "./compose-templates";

export const validateIdentity = async (params: {
  mailboxId: string;
  senderIdentityId: string;
  db: typeof sql;
}): Promise<
  Result<{
    defaultCc: MailAddress[];
    defaultBcc: MailAddress[];
    defaultFormat: MailComposeFormat;
    defaultPriority: MailPriority;
    defaultDeliveryReceipt: boolean;
    defaultReadReceipt: boolean;
  }>
> => {
  const [identity] = await params.db<
    {
      default_cc: MailAddress[] | string;
      default_bcc: MailAddress[] | string;
      default_format: MailComposeFormat;
      default_priority: MailPriority;
      default_delivery_receipt: boolean;
      default_read_receipt: boolean;
    }[]
  >`
    SELECT
      default_cc,
      default_bcc,
      default_format,
      default_priority,
      default_delivery_receipt,
      default_read_receipt
    FROM mail.sender_identities
    WHERE id = ${params.senderIdentityId}::uuid
      AND mailbox_id = ${params.mailboxId}::uuid
      AND status = 'verified'
    FOR SHARE
  `;
  if (!identity) return fail(err.badInput("A verified sender identity is required"));
  return ok({
    defaultCc: typeof identity.default_cc === "string" ? (JSON.parse(identity.default_cc) as MailAddress[]) : identity.default_cc,
    defaultBcc: typeof identity.default_bcc === "string" ? (JSON.parse(identity.default_bcc) as MailAddress[]) : identity.default_bcc,
    defaultFormat: identity.default_format,
    defaultPriority: identity.default_priority,
    defaultDeliveryReceipt: identity.default_delivery_receipt,
    defaultReadReceipt: identity.default_read_receipt,
  });
};

// A body from before drafts stored their signature may still hold it as a segment; only then are templates read.
export const legacySignature = async (db: typeof sql, context: MailRequestContext, mailboxId: string, body: string) =>
  body.includes("\u2063") ? moveSignatureSegment(body, await selectableSignatures(db, context, mailboxId)) : null;

/**
 * The signature a draft write stores, and its body without that signature's legacy segments. An omitted choice
 * keeps the stored one or takes the first recognized segment of a legacy draft, stored body first, because the
 * draft view already moved that segment out. Other segments and the body of an explicit choice stay as sent,
 * so preview and send keep rendering them where the writer saw them.
 */
export const resolveDraftSignature = async (params: {
  db: typeof sql;
  context: MailRequestContext;
  mailboxId: string;
  stored: { body: string; signatureTemplateId: string | null };
  body: string;
  requested: string | null | undefined;
}): Promise<Result<{ body: string; signatureTemplateId: string | null }>> => {
  const { db, context, mailboxId, stored, requested } = params;
  const signatureTemplateId =
    requested === undefined
      ? (stored.signatureTemplateId ??
        (await legacySignature(db, context, mailboxId, stored.body))?.signatureTemplateId ??
        (await legacySignature(db, context, mailboxId, params.body))?.signatureTemplateId ??
        null)
      : requested;
  if (requested !== undefined && signatureTemplateId !== null && signatureTemplateId !== stored.signatureTemplateId) {
    const selectable = await requireSelectableSignature(db, context, mailboxId, signatureTemplateId);
    if (!selectable.ok) return selectable;
  }
  let body = params.body;
  if (signatureTemplateId !== null && body.includes("\u2063")) {
    const [signature] = await db<{ body_template: string }[]>`
      SELECT body_template FROM mail.compose_templates
      WHERE id = ${signatureTemplateId}::uuid AND mailbox_id = ${mailboxId}::uuid
        AND kind = 'signature' AND archived_at IS NULL
    `;
    if (signature) body = withoutSignatureSegments(body, signature.body_template);
  }
  return ok({ body, signatureTemplateId });
};

/** Translate the owning service's UUID fields before they enter a browser document. */
export const publicDraftContent = async (
  db: typeof sql,
  mailboxId: string,
  content: DraftEditableContent,
): Promise<Result<DraftEditableContent>> => {
  const [sender] = await db<{ short_id: string }[]>`
    SELECT short_id FROM mail.sender_identities WHERE id = ${content.senderIdentityId}::uuid AND mailbox_id = ${mailboxId}::uuid
  `;
  if (!sender) return fail(err.badInput("Sender identity is no longer available"));
  let signatureTemplateId: string | null | undefined = content.signatureTemplateId;
  if (signatureTemplateId) {
    const [signature] = await db<{ short_id: string }[]>`
      SELECT short_id FROM mail.compose_templates WHERE id = ${signatureTemplateId}::uuid AND mailbox_id = ${mailboxId}::uuid
    `;
    if (!signature) return fail(err.badInput("Signature is no longer available"));
    signatureTemplateId = signature.short_id;
  }
  const parsed = draftEditableContentInputSchema.safeParse({ ...content, senderIdentityId: sender.short_id, signatureTemplateId });
  return parsed.success ? ok(parsed.data) : fail(err.badInput("Draft content is invalid"));
};
