import { z } from "zod";

export const LARGE_MAIL_VIEWS = ["auto", "columns", "split"] as const;
export const PHONE_MAIL_VIEWS = ["compact", "detailed"] as const;
export const mailViewPreferenceSchema = z.object({
  large: z.enum(LARGE_MAIL_VIEWS),
  phone: z.enum(PHONE_MAIL_VIEWS),
});
export const mailViewPreferenceChangeSchema = mailViewPreferenceSchema
  .partial()
  .refine((value) => value.large !== undefined || value.phone !== undefined, "Set large, phone, or both");
export type MailViewPreference = z.infer<typeof mailViewPreferenceSchema>;
export type MailViewPreferenceChange = z.infer<typeof mailViewPreferenceChangeSchema>;
export const DEFAULT_MAIL_VIEW: MailViewPreference = { large: "auto", phone: "compact" };
export const mailDoneTodayCountsSchema = z.object({
  doneToday: z.number().int().nonnegative(),
  doneByAutomation: z.number().int().nonnegative(),
});
export type MailDoneTodayCounts = z.infer<typeof mailDoneTodayCountsSchema>;
