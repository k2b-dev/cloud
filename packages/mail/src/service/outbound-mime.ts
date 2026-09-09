import { markdown, sanitizeEmailHtml } from "@k2b/cloud/shared";
import MailComposer from "nodemailer/lib/mail-composer";
import { Readable } from "node:stream";
import { z } from "zod";
import { mailAddressSchema, mailPrioritySchema } from "../contracts";

const outboundDraftSnapshotBaseSchema = z.object({
  revision: z.number().int().positive(),
  from: z.object({ name: z.string().max(200), address: z.string().email().max(320) }),
  replyTo: z.string().email().max(320).nullable(),
  envelopeFrom: z.string().email().max(320).nullable(),
  useNullEnvelopeSender: z.boolean().default(false),
  automaticReply: z.boolean().default(false),
  priority: mailPrioritySchema.default("normal"),
  requestDeliveryReceipt: z.boolean().default(false),
  requestReadReceipt: z.boolean().default(false),
  receiptAddress: z.string().email().max(320).nullable().default(null),
  vcard: z
    .string()
    .max(256 * 1024)
    .nullable()
    .default(null),
  to: z.array(mailAddressSchema).max(200),
  cc: z.array(mailAddressSchema).max(200),
  bcc: z.array(mailAddressSchema).max(200),
  subject: z.string().max(998),
  body: z.string().max(2 * 1024 * 1024),
  inReplyTo: z.string().max(998).nullable().default(null),
  references: z.array(z.string().max(998)).max(500).default([]),
  attachments: z
    .array(
      z.object({
        id: z.string().uuid(),
        blobId: z.string().uuid(),
        filename: z.string().min(1).max(255),
        contentType: z.string().min(1).max(255),
        byteLength: z.number().int().nonnegative(),
        contentHash: z.string().length(64),
      }),
    )
    .max(200)
    .default([]),
});

export const outboundDraftSnapshotSchema = z.discriminatedUnion("format", [
  outboundDraftSnapshotBaseSchema.extend({
    format: z.literal("plain"),
    renderedText: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    renderedHtml: z.null().optional(),
  }),
  outboundDraftSnapshotBaseSchema.extend({
    format: z.literal("markdown"),
    renderedText: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    renderedHtml: z
      .string()
      .max(3 * 1024 * 1024)
      .nullable()
      .optional(),
  }),
]);

export type OutboundDraftSnapshot = z.infer<typeof outboundDraftSnapshotSchema>;

const formatAddress = (address: { name?: string | null; address: string }) => ({
  name: address.name?.trim() ?? "",
  address: address.address,
});

export const buildMimeStream = (params: {
  snapshot: OutboundDraftSnapshot;
  messageId: string;
  date: Date;
  openAttachment: (blobId: string) => Readable;
}): Readable => {
  const html =
    params.snapshot.format === "plain"
      ? undefined
      : params.snapshot.renderedHtml === undefined
        ? sanitizeEmailHtml(markdown.renderSync(params.snapshot.body))
        : (params.snapshot.renderedHtml ?? undefined);
  const headers: Record<string, string> = {};
  if (params.snapshot.automaticReply) {
    headers["Auto-Submitted"] = "auto-replied";
    headers["X-Auto-Response-Suppress"] = "All";
  }
  if (params.snapshot.priority === "high") {
    headers.Importance = "high";
    headers.Priority = "urgent";
    headers["X-Priority"] = "1";
  } else if (params.snapshot.priority === "low") {
    headers.Importance = "low";
    headers.Priority = "non-urgent";
    headers["X-Priority"] = "5";
  }
  if (params.snapshot.requestReadReceipt && params.snapshot.receiptAddress) {
    headers["Disposition-Notification-To"] = params.snapshot.receiptAddress;
  }
  const attachments = params.snapshot.attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    content: params.openAttachment(attachment.blobId),
  }));
  if (params.snapshot.vcard) {
    attachments.push({
      filename: "contact.vcf",
      contentType: "text/vcard; charset=utf-8",
      content: Readable.from(Buffer.from(params.snapshot.vcard, "utf8")),
    });
  }
  return new MailComposer({
    from: formatAddress(params.snapshot.from),
    replyTo: params.snapshot.replyTo ?? undefined,
    to: params.snapshot.to.map(formatAddress),
    cc: params.snapshot.cc.map(formatAddress),
    bcc: params.snapshot.bcc.map(formatAddress),
    subject: params.snapshot.subject,
    text: params.snapshot.renderedText ?? params.snapshot.body,
    html,
    messageId: params.messageId,
    date: params.date,
    inReplyTo: params.snapshot.inReplyTo ?? undefined,
    references: params.snapshot.references,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    attachments,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .createReadStream();
};

export const buildMimeSource = async (params: {
  snapshot: OutboundDraftSnapshot;
  messageId: string;
  date: Date;
  openAttachment?: (blobId: string) => Readable;
}): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const value of buildMimeStream({
    ...params,
    openAttachment:
      params.openAttachment ??
      (() => {
        throw new Error("Attachment source is required");
      }),
  })) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array));
  }
  return Buffer.concat(chunks);
};

export const measureMimeStream = async (params: Parameters<typeof buildMimeStream>[0]): Promise<number> => {
  let byteLength = 0;
  for await (const value of buildMimeStream(params)) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      byteLength += value.byteLength;
      continue;
    }
    byteLength += Buffer.byteLength(String(value));
  }
  return byteLength;
};

export const outboundRecipients = (snapshot: OutboundDraftSnapshot): string[] =>
  [...snapshot.to, ...snapshot.cc, ...snapshot.bcc].map((recipient) => recipient.address.toLowerCase());
