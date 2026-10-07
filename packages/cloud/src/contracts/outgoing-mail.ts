import { z } from "zod";

export const PlatformPermissionSchema = z.enum(["mail:send"]);
export type PlatformPermission = z.infer<typeof PlatformPermissionSchema>;
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
