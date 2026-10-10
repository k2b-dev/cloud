import { z } from "zod";
import type { AnnouncementCookieState } from "./announcement-cookie";

export {
  ANNOUNCEMENTS_COOKIE,
  ANNOUNCEMENTS_COOKIE_MAX_AGE_SECONDS,
  type AnnouncementCookieState,
  DEFAULT_ANNOUNCEMENT_COOKIE_STATE,
  MAX_DISMISSED_BANNER_VERSIONS,
  mergeAnnouncementCookieState,
  parseAnnouncementCookieHeader,
  parseAnnouncementCookieValue,
  serializeAnnouncementCookieState,
} from "./announcement-cookie";

export const AnnouncementKindSchema = z.enum(["announcement", "banner"]);
export type AnnouncementKind = z.infer<typeof AnnouncementKindSchema>;

export const AnnouncementToneSchema = z.enum(["info", "success", "warning", "danger"]);
export type AnnouncementTone = z.infer<typeof AnnouncementToneSchema>;

export const AnnouncementCookieStateSchema = z.object({
  seenAnnouncementVersion: z.number().int().nonnegative().default(0),
  dismissedBannerVersions: z.array(z.number().int().positive()).default([]),
}) satisfies z.ZodType<AnnouncementCookieState>;

export const AnnouncementEntrySchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  kind: AnnouncementKindSchema,
  title: z.string(),
  body: z.string(),
  tone: AnnouncementToneSchema,
  publishedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
});
export type AnnouncementEntry = z.infer<typeof AnnouncementEntrySchema>;

export const AnnouncementDisplayEntrySchema = AnnouncementEntrySchema.omit({ body: true }).extend({
  bodyHtml: z.string(),
});
export type AnnouncementDisplayEntry = z.infer<typeof AnnouncementDisplayEntrySchema>;

const DatetimeInputSchema = z.string().datetime();
const NullableDatetimeInputSchema = z.string().datetime().nullable();

export const CreateAnnouncementSchema = z.object({
  kind: AnnouncementKindSchema,
  title: z.string().trim().min(1).max(180),
  body: z.string().trim().min(1).max(20_000),
  tone: AnnouncementToneSchema.default("info"),
  publishedAt: DatetimeInputSchema.optional(),
  expiresAt: NullableDatetimeInputSchema.optional(),
});
export type CreateAnnouncement = z.infer<typeof CreateAnnouncementSchema>;

export const UpdateAnnouncementSchema = z
  .object({
    kind: AnnouncementKindSchema.optional(),
    title: z.string().trim().min(1).max(180).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
    tone: AnnouncementToneSchema.optional(),
    publishedAt: DatetimeInputSchema.optional(),
    expiresAt: NullableDatetimeInputSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.");
export type UpdateAnnouncement = z.infer<typeof UpdateAnnouncementSchema>;

export const AnnouncementListResponseSchema = z.object({
  items: z.array(AnnouncementEntrySchema),
});
export type AnnouncementListResponse = z.infer<typeof AnnouncementListResponseSchema>;

export const ActiveAnnouncementsResponseSchema = z.object({
  banners: z.array(AnnouncementDisplayEntrySchema),
  announcements: z.array(AnnouncementDisplayEntrySchema),
  latestAnnouncementVersion: z.number().int().nonnegative(),
});
export type ActiveAnnouncementsResponse = z.infer<typeof ActiveAnnouncementsResponseSchema>;
