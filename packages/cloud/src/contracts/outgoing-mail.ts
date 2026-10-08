import type { PageParams, Paginated, ServiceError } from "@k2b/stdlib";
import { z } from "zod";
import { type RequestActor, ServiceAccountSchema, UserSchema } from "./shared";

export const PlatformPermissionSchema = z.enum(["mail:send"]);
export type PlatformPermission = z.infer<typeof PlatformPermissionSchema>;
export const MailRetentionSchema = z.object({ contentDays: z.int().min(1).max(36500), recordDays: z.int().min(1).max(36500) }).strict();
export type MailRetention = z.infer<typeof MailRetentionSchema>;

export const MailProfileKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const headerText = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !/[\r\n\0]/.test(value), "Header must not contain control characters");
export const MailProfileInputSchema = z
  .object({
    name: headerText,
    fromAddress: z.email().max(320),
    fromName: headerText.nullable(),
    smtpHost: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .refine((value) => !/[\s/@\0]/.test(value), "Use an SMTP hostname"),
    smtpPort: z.int().min(1).max(65535),
    smtpSecure: z.boolean(),
    smtpUser: z.string().max(320).nullable(),
    smtpPassword: z.string().max(16384).nullable().optional(),
    pacePerMinute: z.int().min(1).max(6000),
    dailyRecipientLimit: z.int().min(1).max(2147483647).nullable(),
    maxAttachmentBytes: z.int().min(1).max(26214400),
    revision: z.int().min(1).max(2147483647).optional(),
  })
  .strict();
export type MailProfileInput = z.infer<typeof MailProfileInputSchema>;
export const MailAppAccessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("selected"), profiles: z.array(MailProfileKeySchema) }).strict(),
]);
export type MailAppAccess = z.infer<typeof MailAppAccessSchema>;
export const MailProfileSchema = z.object({
  key: MailProfileKeySchema,
  name: z.string(),
  from: z.email(),
  default: z.boolean(),
  maxAttachmentBytes: z.int(),
  quota: z.object({ dailyRecipients: z.int().nullable(), usedLast24h: z.int() }),
});
export type MailProfile = z.infer<typeof MailProfileSchema>;
export const MailErrorCodeSchema = z.enum([
  "bad_input",
  "profile_not_allowed",
  "profile_required",
  "quota_exceeded",
  "backlog_full",
  "attachments_too_large",
  "attachment_storage_full",
  "profile_removed",
  "attachment_lost",
  "cancelled_by_admin",
  "message_unknown",
  "batch_unknown",
  "message_not_queued",
  "mail_unavailable",
  "mail_not_declared",
  "profile_unknown",
  "profile_exists",
  "profile_is_default",
  "revision_conflict",
  "invalid_profile",
  "smtp_failed",
]);
export type MailErrorCode = z.infer<typeof MailErrorCodeSchema>;
export const AdminMailProfileSchema = MailProfileInputSchema.omit({ smtpPassword: true, revision: true }).extend({
  key: MailProfileKeySchema,
  hasPassword: z.boolean(),
  isDefault: z.boolean(),
  revision: z.int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  appCount: z.int(),
});
export type AdminMailProfile = z.infer<typeof AdminMailProfileSchema>;
export type AdminMailApp = {
  appId: string;
  name: string;
  registered: boolean;
  declared: boolean;
  mode: "default" | "selected";
  profiles: string[];
};

export const MailStatusSchema = z.enum(["queued", "sending", "sent", "failed", "bounced", "cancelled"]);
export type MailStatus = z.infer<typeof MailStatusSchema>;
export type MailAttachment = {
  filename: string;
  contentType: string;
  content: Uint8Array | Blob | ReadableStream<Uint8Array>;
};
const body = z
  .string()
  .refine((value) => !value.includes("\0"), "Body must not contain NUL")
  .max(512 * 1024)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 512 * 1024, "Body exceeds 512 KiB");
const safeHeader = z.string().refine((value) => !/[\r\n\0]/.test(value), "Header must not contain control characters");
const allowedHeaders = new Set([
  "list-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "in-reply-to",
  "references",
  "auto-submitted",
  "precedence",
]);
export const MailHeadersSchema = z.record(z.string(), safeHeader).refine((headers) => {
  let bytes = 0;
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[\x21-\x39\x3B-\x7E]+$/.test(name) || seen.has(lower)) return false;
    seen.add(lower);
    if (!(lower.startsWith("x-") && !lower.startsWith("x-cloud-")) && !allowedHeaders.has(lower)) return false;
    bytes += new TextEncoder().encode(`${name}: ${value}\r\n`).byteLength;
  }
  return bytes <= 8192;
}, "Invalid mail headers or headers exceed 8 KiB");
const referenceText = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.includes("\0"), "Reference must not contain NUL");
const ref = z.object({ scope: referenceText, id: referenceText }).strict();
const mailAddress = z.email({ pattern: z.regexes.html5Email }).max(320);
export const MailMessageSchema = z
  .object({
    to: z.array(mailAddress).min(1).max(50),
    subject: safeHeader.max(998),
    text: body,
    html: body.optional(),
    fromName: safeHeader.max(998).optional(),
    replyTo: mailAddress.optional(),
    attachments: z
      .array(
        z
          .object({
            filename: safeHeader.min(1).max(998),
            contentType: safeHeader.min(1).max(998),
            content: z.custom<MailAttachment["content"]>(
              (value) => value instanceof Uint8Array || value instanceof Blob || value instanceof ReadableStream,
            ),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    headers: MailHeadersSchema.optional(),
    profile: MailProfileKeySchema.optional(),
    ref: ref.optional(),
    actor: z
      .custom<RequestActor>((value) => {
        if (!value || typeof value !== "object" || !("kind" in value)) return false;
        if (value.kind === "user" && "user" in value) return UserSchema.safeParse(value.user).success;
        return (
          value.kind === "service_account" && "serviceAccount" in value && ServiceAccountSchema.safeParse(value.serviceAccount).success
        );
      })
      .optional(),
    key: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !value.includes("\0"), "Key must not contain NUL")
      .optional(),
  })
  .strict();
export type MailMessage = z.infer<typeof MailMessageSchema>;
export const MailBatchSchema = z
  .array(MailMessageSchema)
  .min(1)
  .max(1000)
  .refine((messages) => {
    const keys = messages.flatMap((message) => (message.key === undefined ? [] : [message.key]));
    return new Set(keys).size === keys.length;
  }, "Duplicate outgoing mail keys in a batch");
export const MailFilterSchema = z
  .object({
    ref: ref.partial({ id: true }).optional(),
    ids: z.array(z.uuid()).max(100).optional(),
    batchId: z.uuid().optional(),
    status: z.array(MailStatusSchema).max(6).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type MailFilter = z.infer<typeof MailFilterSchema>;
export const MailRecordSchema = z.object({
  id: z.uuid(),
  batchId: z.uuid().optional(),
  profile: z.string(),
  ref: ref.optional(),
  to: z.array(z.string()),
  subject: z.string(),
  text: z.string().optional(),
  attachments: z.array(z.object({ filename: z.string(), contentType: z.string(), size: z.int().nonnegative(), sha256: z.string() })),
  status: MailStatusSchema,
  error: z.string().optional(),
  failures: z.array(z.object({ recipient: z.string(), reason: z.string(), at: z.string() })),
  attempts: z.int(),
  actor: z.object({ id: z.string(), name: z.string() }).optional(),
  createdAt: z.string(),
  sentAt: z.string().optional(),
  contentPurgedAt: z.string().optional(),
});
export type MailRecord = z.infer<typeof MailRecordSchema>;
export const AdminMailRecordSchema = MailRecordSchema.omit({ text: true }).extend({
  appId: z.string(),
  errorCode: z.string().optional(),
  response: z.string().optional(),
});
export type AdminMailRecord = z.infer<typeof AdminMailRecordSchema>;
/** Extends the shared offset-page shape with stable keyset navigation. */
export type MailPageParams = PageParams & { cursor?: string };
export type MailPage<T = MailRecord> = Paginated<T> & { nextCursor?: string };
export const MailPageParamsSchema = z
  .object({ page: z.int().min(1).optional(), perPage: z.int().min(1).max(100).optional(), cursor: z.string().max(1024).optional() })
  .strict();
export const AdminMailFilterSchema = MailFilterSchema.extend({
  app: z.string().min(1).optional(),
  profile: MailProfileKeySchema.optional(),
  recipient: z.string().max(320).optional(),
});
export type AdminMailFilter = z.infer<typeof AdminMailFilterSchema>;
export type MailServiceError = ServiceError<MailErrorCode> & {
  limit?: number;
  used?: number;
  requested?: number;
};
