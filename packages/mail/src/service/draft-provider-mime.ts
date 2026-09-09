import type { Readable } from "node:stream";
import { markdown, sanitizeEmailHtml } from "@k2b/cloud/shared";
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";
import { mailAddressSchema } from "../contracts";
import { sha256Json } from "./canonical";

const draftProviderAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    blobId: z.string().uuid(),
    filename: z.string().min(1).max(255),
    contentType: z.string().min(1).max(255),
    byteLength: z.number().int().nonnegative(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const draftProviderContentSchema = z
  .object({
    revision: z.number().int().positive(),
    senderIdentityId: z.string().uuid(),
    from: z.object({ name: z.string().max(200), address: z.string().email().max(320) }).strict(),
    replyTo: z.string().email().max(320).nullable(),
    to: z.array(mailAddressSchema).max(200),
    cc: z.array(mailAddressSchema).max(200),
    bcc: z.array(mailAddressSchema).max(200),
    subject: z.string().max(998),
    body: z.string().max(2 * 1024 * 1024),
    format: z.enum(["plain", "markdown"]),
    inReplyTo: z.string().max(998).nullable(),
    references: z.array(z.string().max(998)).max(500),
    attachments: z.array(draftProviderAttachmentSchema).max(200),
  })
  .strict();

export type DraftProviderContent = z.infer<typeof draftProviderContentSchema>;

const formatAddress = (address: { name?: string | null; address: string }) => ({
  name: address.name?.trim() ?? "",
  address: address.address,
});

export const draftProviderFingerprint = (content: DraftProviderContent): string =>
  sha256Json({
    senderIdentityId: content.senderIdentityId,
    from: content.from,
    replyTo: content.replyTo,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
    subject: content.subject,
    body: content.body,
    format: content.format,
    inReplyTo: content.inReplyTo,
    references: content.references,
    attachments: content.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteLength: attachment.byteLength,
      contentHash: attachment.contentHash,
    })),
  });

export const draftProviderMessageId = (snapshotId: string): string => `<cloud-draft-${snapshotId}@cloud.invalid>`;

export const buildDraftProviderMimeStream = (params: {
  snapshotId: string;
  draftId: string;
  content: DraftProviderContent;
  fingerprint: string;
  messageId: string;
  date: Date;
  openAttachment: (blobId: string) => Readable;
}): Readable => {
  const html = params.content.format === "markdown" ? sanitizeEmailHtml(markdown.renderSync(params.content.body)) : undefined;
  const composer = new MailComposer({
    from: formatAddress(params.content.from),
    replyTo: params.content.replyTo ?? undefined,
    to: params.content.to.map(formatAddress),
    cc: params.content.cc.map(formatAddress),
    bcc: params.content.bcc.map(formatAddress),
    subject: params.content.subject,
    text: params.content.body,
    html,
    messageId: params.messageId,
    date: params.date,
    inReplyTo: params.content.inReplyTo ?? undefined,
    references: params.content.references,
    headers: {
      "X-Cloud-Draft-ID": params.draftId,
      "X-Cloud-Draft-Revision": String(params.content.revision),
      "X-Cloud-Draft-Snapshot": params.snapshotId,
      "X-Cloud-Draft-Fingerprint": params.fingerprint,
      "X-Cloud-Draft-Format": params.content.format,
    },
    attachments: params.content.attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      content: params.openAttachment(attachment.blobId),
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const compiled = composer.compile();
  compiled.keepBcc = true;
  return compiled.createReadStream();
};
