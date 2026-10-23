import { z } from "zod";
import { isSafeNotificationTargetHref } from "./notification-types";

export const NotificationInboxQuerySchema = z
  .object({
    // Keep the largest offset exactly representable, even at the page-size limit.
    page: z.coerce
      .number()
      .int()
      .min(1)
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 100))
      .default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/** The encrypted, channel-neutral inbox content. Browser previews never enter it. */
export const NotificationInboxContentSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(4_000).nullable(),
  targetHref: z.string().refine(isSafeNotificationTargetHref).nullable(),
});

export const NotificationInboxItemSchema = NotificationInboxContentSchema.extend({
  id: z.uuid(),
  eventId: z.uuid(),
  definitionId: z.string(),
  appId: z.string(),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime(),
});

export const NotificationInboxResponseSchema = z.object({
  items: z.array(NotificationInboxItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().min(1).max(100),
  totalPages: z.number().int().nonnegative(),
});
export type NotificationInboxResponse = z.infer<typeof NotificationInboxResponseSchema>;
