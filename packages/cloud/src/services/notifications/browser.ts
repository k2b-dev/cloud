import { createHash } from "node:crypto";
import { sql } from "bun";
import webpush from "web-push";
import { z } from "zod";
import { isSafeNotificationTargetHref } from "../../contracts/notification-types";
import { type BrowserPushSubscription, BrowserPushSubscriptionSchema } from "../../contracts/user-notifications";
import { decryptSecret, encryptSecret } from "../secrets";
import { coreSettings } from "../settings/api";
import { type NotificationDestination, registerNotificationChannel } from "./channels";
import { sendPinnedWebPush } from "./web-push-transport";

type EndpointRow = {
  id: string;
  endpoint_hash: string;
  label: string;
  secret_encrypted: string;
};

type BrowserDeliveryPayload = {
  endpointId: string;
  subscription: BrowserPushSubscription;
  eventId: string;
  title: string;
  targetHref?: string;
};

const BrowserDeliveryPayloadSchema = z.object({
  endpointId: z.uuid(),
  subscription: BrowserPushSubscriptionSchema,
  eventId: z.uuid(),
  title: z.string().min(1).max(200),
  targetHref: z.string().max(4_000).refine(isSafeNotificationTargetHref).optional(),
});

const BrowserDestinationContextSchema = z.object({
  endpointId: z.uuid(),
  subscription: BrowserPushSubscriptionSchema,
});

const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint).digest("hex");

let vapidConfigPromise: Promise<{ publicKey: string; privateKey: string }> | null = null;
let webPushConfigurationPromise: Promise<void> | null = null;
let unregisterDriver: (() => void) | null = null;

const ensureVapidConfig = (): Promise<{ publicKey: string; privateKey: string }> => {
  if (vapidConfigPromise) return vapidConfigPromise;
  vapidConfigPromise = sql
    .begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('notifications:web-push-vapid', 0))`;
      let [publicKey, privateKey] = await Promise.all([
        coreSettings.get<string>("notifications.web_push_public_key"),
        coreSettings.get<string>("notifications.web_push_private_key"),
      ]);
      if (!publicKey || !privateKey) {
        const generated = webpush.generateVAPIDKeys();
        publicKey = generated.publicKey;
        privateKey = generated.privateKey;
        await coreSettings.set("notifications.web_push_public_key", publicKey);
        await coreSettings.set("notifications.web_push_private_key", privateKey);
      }
      return { publicKey, privateKey };
    })
    .catch((error) => {
      vapidConfigPromise = null;
      throw error;
    });
  return vapidConfigPromise;
};

const vapidSubject = async (): Promise<string> => {
  const [configuredUrl, contactEmail] = await Promise.all([
    coreSettings.get<string>("app.url"),
    coreSettings.get<string>("app.contact_email"),
  ]);
  const rawUrl = configuredUrl?.trim();
  if (rawUrl) {
    try {
      const parsed = new URL(/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
      const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
      if (parsed.protocol === "https:" && !isLocalhost) return parsed.origin;
    } catch {
      // Fall through to the deployment contact below.
    }
  }
  return contactEmail?.trim() ? `mailto:${contactEmail.trim()}` : "mailto:notifications@cloud.local";
};

const ensureWebPushConfigured = (): Promise<void> => {
  if (webPushConfigurationPromise) return webPushConfigurationPromise;
  webPushConfigurationPromise = Promise.all([ensureVapidConfig(), vapidSubject()])
    .then(([config, subject]) => {
      webpush.setVapidDetails(subject, config.publicKey, config.privateKey);
    })
    .catch((error) => {
      webPushConfigurationPromise = null;
      throw error;
    });
  return webPushConfigurationPromise;
};

const disableEndpoint = async (endpointId: string): Promise<void> => {
  await sql`
    UPDATE notifications.endpoints
    SET disabled_at = now(), updated_at = now()
    WHERE id = ${endpointId}::uuid AND channel = 'browser'
  `;
};

const browserDriver = {
  id: "browser" as const,
  resolveDestinations: async (recipient: { userId: string | null }) => {
    if (!recipient.userId) return [];
    const rows = await sql<EndpointRow[]>`
      SELECT id, endpoint_hash, label, secret_encrypted
      FROM notifications.endpoints
      WHERE user_id = ${recipient.userId}::uuid
        AND channel = 'browser'
        AND verified_at IS NOT NULL
        AND disabled_at IS NULL
      ORDER BY last_seen_at DESC, id
    `;
    const destinations: NotificationDestination[] = [];
    for (const row of rows) {
      try {
        const subscription = BrowserPushSubscriptionSchema.parse(await decryptSecret(row.secret_encrypted));
        if (subscription.expirationTime && subscription.expirationTime <= Date.now()) {
          await disableEndpoint(row.id);
          continue;
        }
        destinations.push({
          key: row.endpoint_hash,
          label: row.label,
          endpointId: row.id,
          context: { endpointId: row.id, subscription },
        });
      } catch {
        await disableEndpoint(row.id);
      }
    }
    return destinations;
  },
  createPayload: ({ presentation, destination, event }) => {
    const context = BrowserDestinationContextSchema.parse(destination.context);
    return BrowserDeliveryPayloadSchema.parse({
      endpointId: context.endpointId,
      subscription: context.subscription,
      eventId: event.id,
      title: presentation.title,
      targetHref: presentation.targetHref,
    });
  },
  deliver: async (value: unknown) => {
    const payload: BrowserDeliveryPayload = BrowserDeliveryPayloadSchema.parse(value);
    // A queued payload can outlive logout, disable, or rebinding this browser to another user.
    const [endpoint] = await sql<{ id: string }[]>`
      SELECT id FROM notifications.endpoints
      WHERE id = ${payload.endpointId}::uuid AND channel = 'browser'
        AND verified_at IS NOT NULL AND disabled_at IS NULL
    `;
    if (!endpoint) {
      throw Object.assign(new Error("Browser notification endpoint is no longer registered"), {
        code: "endpoint_gone",
        retryable: false,
      });
    }
    await ensureWebPushConfigured();
    try {
      await sendPinnedWebPush(
        payload.subscription,
        JSON.stringify({
          type: "cloud-notification",
          eventId: payload.eventId,
          title: payload.title,
          targetHref: payload.targetHref,
        }),
        {
          TTL: 24 * 60 * 60,
          urgency: "normal",
          topic: createHash("sha256").update(payload.eventId).digest("base64url").slice(0, 32),
        },
      );
    } catch (error) {
      const statusCode = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : null;
      if (statusCode === 404 || statusCode === 410) {
        await disableEndpoint(payload.endpointId);
        throw Object.assign(new Error("Browser notification endpoint is no longer registered"), {
          code: "endpoint_gone",
          retryable: false,
        });
      }
      if (statusCode !== null && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) {
        throw Object.assign(new Error("Browser push provider rejected the delivery"), {
          code: "provider_rejected",
          retryable: false,
        });
      }
      throw error;
    }
  },
} satisfies import("./channels").NotificationChannelDriver;

// Every app process may create deliveries; Core remains the only process that
// runs the durable delivery queue.
unregisterDriver = registerNotificationChannel(browserDriver);

export const browserNotifications = {
  start: async (): Promise<void> => {
    unregisterDriver ??= registerNotificationChannel(browserDriver);
    await ensureWebPushConfigured();
  },
  stop: (): void => {
    unregisterDriver?.();
    unregisterDriver = null;
  },
  configuration: async (): Promise<{ publicKey: string }> => {
    const config = await ensureVapidConfig();
    return { publicKey: config.publicKey };
  },
  registerEndpoint: async (config: {
    userId: string;
    subscription: BrowserPushSubscription;
    label: string;
  }): Promise<{ id: string; label: string }> => {
    const subscription = BrowserPushSubscriptionSchema.parse(config.subscription);
    const hash = endpointHash(subscription.endpoint);
    const encrypted = await encryptSecret(subscription);
    const label = config.label.trim().slice(0, 120) || "This browser";
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`notifications:browser:${hash}`}, 0))`;
      await tx`
        UPDATE notifications.endpoints
        SET disabled_at = now(), updated_at = now()
        WHERE channel = 'browser' AND endpoint_hash = ${hash}
          AND user_id <> ${config.userId}::uuid AND disabled_at IS NULL
      `;
      return tx<{ id: string; label: string }[]>`
        INSERT INTO notifications.endpoints (
          user_id, channel, endpoint_hash, label, secret_encrypted,
          verified_at, last_seen_at, disabled_at, updated_at
        ) VALUES (
          ${config.userId}::uuid, 'browser', ${hash}, ${label}, ${encrypted},
          now(), now(), NULL, now()
        )
        ON CONFLICT (user_id, channel, endpoint_hash) DO UPDATE
        SET label = EXCLUDED.label, secret_encrypted = EXCLUDED.secret_encrypted,
            verified_at = now(), last_seen_at = now(), disabled_at = NULL, updated_at = now()
        RETURNING id, label
      `;
    });
    return rows[0]!;
  },
  disableEndpoint: async (config: { userId: string; subscription: BrowserPushSubscription }): Promise<boolean> => {
    const subscription = BrowserPushSubscriptionSchema.parse(config.subscription);
    const rows = await sql<{ id: string }[]>`
      UPDATE notifications.endpoints
      SET disabled_at = now(), updated_at = now()
      WHERE user_id = ${config.userId}::uuid AND channel = 'browser'
        AND endpoint_hash = ${endpointHash(subscription.endpoint)} AND disabled_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  },
} as const;
