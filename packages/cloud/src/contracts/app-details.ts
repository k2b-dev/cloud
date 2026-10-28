import { z } from "zod";
import { PlatformPermissionSchema } from "./outgoing-mail";
import { RoleSchema } from "./shared";

/** Match the administrative event API's maximum page size. Totals make truncation visible. */
export const APP_DETAILS_LIST_LIMIT = 100;
export const APP_DETAILS_FAILED_LIMIT = 5;
export const APP_SUBSCRIPTION_NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const count = z.number().int().nonnegative();
const deliveryCounts = z.object({ pending: count, retrying: count, done: count, failed: count, cancelled: count });

export const AppDetailsSchema = z.object({
  app: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    accent: z.templateLiteral(["#", z.string()]).nullable(),
    online: z.boolean(),
  }),
  access: z.object({
    /** Null means Core has no current access declaration for an offline app. */
    kind: z.enum(["grants", "signedIn", "noGuests", "roles", "legacy"]).nullable(),
    roles: z.array(RoleSchema),
    grantCount: count.nullable(),
    platformPermissions: z.array(PlatformPermissionSchema),
  }),
  sends: z
    .array(
      z.object({
        type: z.string(),
        version: z.number().int().positive(),
        title: z.string(),
        description: z.string(),
        subject: z.string(),
        place: z.string().nullable(),
        automation: z.boolean(),
        subscriberCount: count,
      }),
    )
    .max(APP_DETAILS_LIST_LIMIT),
  hears: z
    .array(
      z.object({
        subscriptionId: z.string(),
        eventType: z.string(),
        version: z.number().int().positive(),
        publisherAppId: z.string(),
        title: z.string().nullable(),
        state: z.enum(["active", "blocked", "cancelled"]),
        reason: z.string().nullable(),
        firstSeenAt: z.iso.datetime(),
        isNew: z.boolean(),
        counts: deliveryCounts,
        failedDeliveries: z
          .array(
            z.object({
              id: z.uuid(),
              eventId: z.uuid(),
              code: z.string().nullable(),
              lastError: z.string().max(1000).nullable(),
              attempts: count,
              lastAttemptAt: z.iso.datetime().nullable(),
            }),
          )
          .max(APP_DETAILS_FAILED_LIMIT),
      }),
    )
    .max(APP_DETAILS_LIST_LIMIT),
  notifications: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        label: z.string(),
        description: z.string(),
        recipientKind: z.enum(["user", "email"]),
        requiredChannels: z.array(z.string()),
        recommendedChannels: z.array(z.string()),
      }),
    )
    .max(APP_DETAILS_LIST_LIMIT),
  totals: z.object({ sends: count, hears: count, notifications: count }),
});

export type AppDetails = z.infer<typeof AppDetailsSchema>;
