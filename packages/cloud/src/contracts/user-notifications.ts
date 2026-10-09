import { z } from "zod";
import { isUnsafeNetworkAddress, isUnsafeNetworkHostname, networkAddressFamily, normalizeNetworkHostname } from "../shared/network-address";

export const NotificationDeliveryStatusSchema = z.enum(["deferred", "pending", "sending", "delivered", "suppressed", "failed"]);
export type NotificationDeliveryStatus = z.infer<typeof NotificationDeliveryStatusSchema>;

export const UserNotificationPreferenceSchema = z.object({
  id: z.string(),
  appId: z.string(),
  kind: z.string(),
  label: z.string(),
  description: z.string(),
  recommendedChannels: z.array(z.string()),
  requiredChannels: z.array(z.string()),
  selectedChannels: z.array(z.string()),
  effectiveChannels: z.array(z.string()),
  customized: z.boolean(),
});
export type UserNotificationPreference = z.infer<typeof UserNotificationPreferenceSchema>;

export const UserNotificationPreferencesResponseSchema = z.object({
  availableChannels: z.array(z.string()),
  definitions: z.array(UserNotificationPreferenceSchema),
});
export type UserNotificationPreferencesResponse = z.infer<typeof UserNotificationPreferencesResponseSchema>;

export const UpdateUserNotificationPreferenceSchema = z.object({
  channels: z.array(z.string().trim().min(1).max(80)).max(20),
});
export type UpdateUserNotificationPreference = z.infer<typeof UpdateUserNotificationPreferenceSchema>;

export const UserNotificationHistoryItemSchema = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  definitionId: z.string(),
  appId: z.string(),
  label: z.string(),
  title: z.string(),
  targetHref: z.string().nullable(),
  channel: z.string(),
  destinationLabel: z.string(),
  required: z.boolean(),
  status: NotificationDeliveryStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  deliveredAt: z.string().datetime().nullable(),
});
export type UserNotificationHistoryItem = z.infer<typeof UserNotificationHistoryItemSchema>;

export const UserNotificationHistoryResponseSchema = z.object({
  items: z.array(UserNotificationHistoryItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  totalPages: z.number().int().nonnegative(),
});
export type UserNotificationHistoryResponse = z.infer<typeof UserNotificationHistoryResponseSchema>;

// Contracts reach the browser bundle, so this uses Intl directly instead of the stdlib date helpers.
const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
};

/** Wall-clock time `HH:MM` in the quiet hours' time zone. */
const QuietTimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time from 00:00 to 23:59");

/**
 * One recurring quiet period. Days are ISO weekdays (1 = Monday … 7 = Sunday). A period that ends at or before
 * its start runs overnight into the next day; equal start and end make 24 hours quiet, so 00:00 to 00:00 is the
 * whole day.
 */
export const NotificationQuietPeriodSchema = z.object({
  days: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .refine((days) => new Set(days).size === days.length, "Each weekday can appear only once"),
  start: QuietTimeOfDaySchema,
  end: QuietTimeOfDaySchema,
});
export type NotificationQuietPeriod = z.infer<typeof NotificationQuietPeriodSchema>;

/** One period per weekday is the most a weekly schedule needs, so seven periods bound the schedule. */
export const NOTIFICATION_QUIET_PERIOD_LIMIT = 7;

export const NotificationQuietHoursSchema = z.object({
  timeZone: z.string().trim().min(1).max(64).refine(isTimeZone, "Unknown time zone"),
  periods: z.array(NotificationQuietPeriodSchema).max(NOTIFICATION_QUIET_PERIOD_LIMIT),
});
export type NotificationQuietHours = z.infer<typeof NotificationQuietHoursSchema>;

export const NotificationQuietReasonSchema = z.enum(["doNotDisturb", "quietHours"]);
export type NotificationQuietReason = z.infer<typeof NotificationQuietReasonSchema>;

/** Whether Cloud holds back browser notifications right now and, when known, until when. */
export const NotificationQuietStateSchema = z.object({
  active: z.boolean(),
  reason: NotificationQuietReasonSchema.nullable(),
  /** End of the current quiet time; null when inactive or when no end lies within the next week. */
  until: z.string().datetime().nullable(),
  /** Start of the next quiet hours while inactive; null when active or when none starts within the next week. */
  nextStart: z.string().datetime().nullable(),
});
export type NotificationQuietState = z.infer<typeof NotificationQuietStateSchema>;

export const NotificationQuietSettingsSchema = z.object({
  doNotDisturbUntil: z.string().datetime().nullable(),
  quietHours: NotificationQuietHoursSchema,
  state: NotificationQuietStateSchema,
});
export type NotificationQuietSettings = z.infer<typeof NotificationQuietSettingsSchema>;

export const UpdateNotificationQuietSettingsSchema = z
  .object({
    /** A future instant pauses browser notifications until then; null resumes them. */
    doNotDisturbUntil: z.iso.datetime({ offset: true }).nullable().optional(),
    quietHours: NotificationQuietHoursSchema.optional(),
  })
  .refine((value) => value.doNotDisturbUntil !== undefined || value.quietHours !== undefined, "Nothing to update");
export type UpdateNotificationQuietSettings = z.infer<typeof UpdateNotificationQuietSettingsSchema>;

export const isSafeBrowserPushEndpoint = (value: string): boolean => {
  try {
    if (/[\\\u0000-\u001f\u007f]/.test(value)) return false;
    const endpoint = new URL(value);
    const hostname = normalizeNetworkHostname(endpoint.hostname);
    const family = networkAddressFamily(hostname);
    return (
      endpoint.protocol === "https:" &&
      !endpoint.username &&
      !endpoint.password &&
      (!endpoint.port || endpoint.port === "443") &&
      !endpoint.hash &&
      !isUnsafeNetworkHostname(hostname) &&
      (family === null || !isUnsafeNetworkAddress(hostname))
    );
  } catch {
    return false;
  }
};

export const BrowserPushSubscriptionSchema = z.object({
  endpoint: z.url().max(4_000).refine(isSafeBrowserPushEndpoint, "Push endpoint must use public HTTPS"),
  expirationTime: z.number().nonnegative().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(500),
    auth: z.string().min(8).max(200),
  }),
});
export type BrowserPushSubscription = z.infer<typeof BrowserPushSubscriptionSchema>;

export const BrowserNotificationConfigurationSchema = z.object({ publicKey: z.string().min(1) });
export type BrowserNotificationConfiguration = z.infer<typeof BrowserNotificationConfigurationSchema>;

export const BrowserNotificationEndpointSchema = z.object({ id: z.uuid(), label: z.string() });
export type BrowserNotificationEndpoint = z.infer<typeof BrowserNotificationEndpointSchema>;

export const RegisterBrowserNotificationEndpointSchema = z.object({
  subscription: BrowserPushSubscriptionSchema,
  label: z.string().trim().min(1).max(120).default("This browser"),
});
export type RegisterBrowserNotificationEndpoint = z.infer<typeof RegisterBrowserNotificationEndpointSchema>;
