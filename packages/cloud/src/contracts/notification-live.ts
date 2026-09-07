import { z } from "zod";
import { isSafeNotificationTargetHref } from "./notification-types";

export const NOTIFICATION_LIVE_WS_TYPE = {
  subscribe: "notifications.live.subscribe",
  ready: "notifications.live.ready",
  event: "notifications.live.event",
  revoked: "notifications.live.revoked",
  error: "notifications.live.error",
} as const;

export const NotificationStreamCursorSchema = z
  .string()
  .regex(/^s6t\.[A-Za-z0-9_-]+\.\d+$/)
  .max(80);

const NotificationTargetHrefSchema = z.custom<`/${string}`>(
  (value) => typeof value === "string" && isSafeNotificationTargetHref(value),
  "Notification target must be a canonical same-origin path",
);

export const NotificationLiveEventSchema = z.object({
  type: z.literal("cloud-notification"),
  eventId: z.string().min(1),
  title: z.string(),
  targetHref: NotificationTargetHrefSchema.optional(),
});

export type NotificationLiveEvent = z.infer<typeof NotificationLiveEventSchema>;

export const NotificationLiveClientMessageSchema = z.object({
  type: z.literal(NOTIFICATION_LIVE_WS_TYPE.subscribe),
  payload: z.object({ fromCursor: NotificationStreamCursorSchema.nullable() }),
});

export type NotificationLiveClientMessage = z.infer<typeof NotificationLiveClientMessageSchema>;

export const NotificationLiveServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(NOTIFICATION_LIVE_WS_TYPE.ready),
    payload: z.object({ cursor: NotificationStreamCursorSchema }),
  }),
  z.object({
    type: z.literal(NOTIFICATION_LIVE_WS_TYPE.event),
    payload: z.object({ cursor: NotificationStreamCursorSchema, event: NotificationLiveEventSchema }),
  }),
  z.object({
    type: z.literal(NOTIFICATION_LIVE_WS_TYPE.revoked),
    payload: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
  z.object({
    type: z.literal(NOTIFICATION_LIVE_WS_TYPE.error),
    payload: z.object({ code: z.string().min(1), message: z.string().min(1) }),
  }),
]);

export type NotificationLiveServerMessage = z.infer<typeof NotificationLiveServerMessageSchema>;

export const parseNotificationLiveServerMessage = (raw: string): NotificationLiveServerMessage | null => {
  try {
    const parsed = NotificationLiveServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
