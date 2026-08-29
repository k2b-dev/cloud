import { sql } from "bun";
import type { output, ZodType } from "zod";
import type {
  BoundNotificationDefinition,
  EmailNotificationPresentation,
  NotificationChannelId,
  NotificationPresentation,
  NotificationRecipientKind,
  NotificationSendInput,
} from "../../contracts/notification-types";
import { validateNotificationTargetHref } from "../../contracts/notification-types";
import { normalizeLocale } from "../../shared/locale";
import { logger } from "../logging";
import { encryptSecret } from "../secrets";
import { ensureNotificationDefinition } from "./catalog";
import { getNotificationChannel, type NotificationDestination, type ResolvedNotificationRecipient } from "./channels";
import { processNotificationDelivery } from "./dispatcher";
import { notificationLive } from "./live";
import { enqueueNotificationDeliveries, enqueueNotificationDelivery } from "./runtime";

export type TypedNotificationDeliveryStatus = "deferred" | "pending" | "sending" | "delivered" | "suppressed" | "failed";

export type TypedNotificationSendResult = {
  id: string;
  created: boolean;
  status: "queued" | "delivered" | "suppressed" | "error";
  deliveries: Array<{
    id: string;
    channel: string;
    required: boolean;
    status: TypedNotificationDeliveryStatus;
    errorCode: string | null;
  }>;
};

type PreparedDelivery = {
  channel: string;
  endpointId: string | null;
  destinationKey: string;
  destinationLabel: string;
  payloadEncrypted: string | null;
  required: boolean;
  routePriority: number | null;
  status: "deferred" | "pending" | "suppressed" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
};

type DeliveryListRow = {
  id: string;
  channel: string;
  required: boolean;
  status: TypedNotificationDeliveryStatus;
  error_code: string | null;
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const log = logger("notifications:platform");

const preparationFailure = (input: { channel: string; required: boolean; routePriority: number | null }): PreparedDelivery => ({
  channel: input.channel,
  endpointId: null,
  destinationKey: "preparation-failed",
  destinationLabel: input.channel,
  payloadEncrypted: null,
  required: input.required,
  routePriority: input.routePriority,
  status: "failed",
  errorCode: "preparation_failed",
  errorMessage: "Notification delivery could not be prepared.",
});

const validatePresentation = (presentation: NotificationPresentation): NotificationPresentation => {
  const title = presentation.title.trim();
  const body = presentation.body?.trim();
  if (!title) throw new Error("Notification title is required");
  if (title.length > 200) throw new Error("Notification title must not exceed 200 characters");
  if (body && body.length > 4_000) throw new Error("Notification body must not exceed 4000 characters");
  const targetHref = presentation.targetHref ? validateNotificationTargetHref(presentation.targetHref) : undefined;
  return { title, ...(body ? { body } : {}), ...(targetHref ? { targetHref } : {}) };
};

const resolveRecipient = async (
  recipient: { userId: string } | { email: string },
): Promise<{
  recipient: ResolvedNotificationRecipient;
  recipientKey: string;
}> => {
  if ("userId" in recipient) {
    const rows = await sql<{ id: string; mail: string | null }[]>`
      SELECT id, btrim(mail) AS mail FROM auth.users WHERE id = ${recipient.userId}::uuid LIMIT 1
    `;
    const user = rows[0];
    if (!user) throw new Error("Notification recipient user was not found");
    return {
      recipient: { userId: user.id, email: user.mail?.trim().toLowerCase() || null },
      recipientKey: `user:${user.id}`,
    };
  }

  const email = recipient.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Notification recipient email is invalid");
  return { recipient: { userId: null, email }, recipientKey: `email:${email}` };
};

const preferredChannels = async (
  definitionId: string,
  recipient: ResolvedNotificationRecipient,
  recommended: readonly NotificationChannelId[],
): Promise<{ channels: string[]; customized: boolean }> => {
  if (!recipient.userId) return { channels: [], customized: false };
  const rows = await sql<{ channels: string[] }[]>`
    SELECT channels FROM notifications.preferences
    WHERE user_id = ${recipient.userId}::uuid AND definition_id = ${definitionId}
    LIMIT 1
  `;
  return rows[0] ? { channels: unique(rows[0].channels), customized: true } : { channels: unique(recommended), customized: false };
};

const prepareChannel = async (input: {
  channel: string;
  recipient: ResolvedNotificationRecipient;
  presentation: NotificationPresentation;
  emailPresentation?: () => Promise<EmailNotificationPresentation | undefined>;
  required: boolean;
  routePriority: number | null;
  event: { id: string; definitionId: string };
}): Promise<PreparedDelivery[]> => {
  const driver = getNotificationChannel(input.channel);
  if (!driver) {
    return [
      {
        channel: input.channel,
        endpointId: null,
        destinationKey: "channel-unavailable",
        destinationLabel: input.channel,
        payloadEncrypted: null,
        required: input.required,
        routePriority: input.routePriority,
        status: "suppressed",
        errorCode: "channel_unavailable",
        errorMessage: `Notification channel "${input.channel}" is unavailable.`,
      },
    ];
  }

  let destinations: NotificationDestination[];
  try {
    destinations = await driver.resolveDestinations(input.recipient);
  } catch (error) {
    log.error("Notification destination resolution failed", {
      channel: input.channel,
      error: error instanceof Error ? error.message : "Notification destination resolution failed",
    });
    return [preparationFailure(input)];
  }
  if (destinations.length === 0) {
    return [
      {
        channel: input.channel,
        endpointId: null,
        destinationKey: "no-endpoint",
        destinationLabel: input.channel,
        payloadEncrypted: null,
        required: input.required,
        routePriority: input.routePriority,
        status: "suppressed",
        errorCode: "no_endpoint",
        errorMessage: `No configured ${input.channel} destination is available.`,
      },
    ];
  }

  try {
    const emailPresentation = input.channel === "email" ? await input.emailPresentation?.() : undefined;
    return await Promise.all(
      destinations.map(async (destination) => ({
        channel: input.channel,
        endpointId: destination.endpointId ?? null,
        destinationKey: destination.key,
        destinationLabel: destination.label,
        payloadEncrypted: await encryptSecret(
          driver.createPayload({ presentation: input.presentation, email: emailPresentation, destination, event: input.event }),
        ),
        required: input.required,
        routePriority: input.routePriority,
        status: "deferred" as const,
        errorCode: null,
        errorMessage: null,
      })),
    );
  } catch (error) {
    log.error("Notification payload preparation failed", {
      channel: input.channel,
      error: error instanceof Error ? error.message : "Notification payload preparation failed",
    });
    return [preparationFailure(input)];
  }
};

const listDeliveries = async (eventId: string): Promise<TypedNotificationSendResult["deliveries"]> => {
  const rows = await sql<DeliveryListRow[]>`
    SELECT id, channel, required, status, error_code
    FROM notifications.deliveries
    WHERE event_id = ${eventId}::uuid
    ORDER BY required DESC, route_priority NULLS FIRST, created_at, id
  `;
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    required: row.required,
    status: row.status,
    errorCode: row.error_code,
  }));
};

const summarize = (id: string, created: boolean, deliveries: TypedNotificationSendResult["deliveries"]): TypedNotificationSendResult => {
  const requiredFailures = deliveries.some(
    (delivery) => delivery.required && (delivery.status === "failed" || delivery.status === "suppressed" || delivery.errorCode !== null),
  );
  const delivered = deliveries.some((delivery) => delivery.status === "delivered");
  const queued = deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "sending");
  return {
    id,
    created,
    status: requiredFailures ? "error" : delivered ? "delivered" : queued ? "queued" : "suppressed",
    deliveries,
  };
};

export const sendTypedNotification = async <
  AppId extends string,
  Key extends string,
  R extends NotificationRecipientKind,
  S extends ZodType,
>(
  definition: BoundNotificationDefinition<AppId, Key, R, S>,
  input: NotificationSendInput<BoundNotificationDefinition<AppId, Key, R, S>>,
): Promise<TypedNotificationSendResult> => {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 300) throw new Error("Notification idempotencyKey must contain 1 to 300 characters");

  const data: output<S> = definition.data.parse(input.data);
  const renderContext = { locale: normalizeLocale(input.locale) };
  const presentation = validatePresentation(await definition.render(data, renderContext));
  const resolved = await resolveRecipient(input.recipient);
  const candidateEventId = crypto.randomUUID();
  await ensureNotificationDefinition(definition);

  const requiredChannels = unique([...(definition.delivery?.required ?? [])]);
  const requiredChannelSet = new Set<string>(requiredChannels);
  const preference = await preferredChannels(definition.id, resolved.recipient, definition.delivery?.recommended ?? []);
  const preferred = preference.channels.filter((channel) => !requiredChannelSet.has(channel));

  const identity = await sql.begin(async (tx) => {
    const eventRows = await tx<{ id: string }[]>`
      INSERT INTO notifications.events (
        id, definition_id, recipient_user_id, recipient_email, recipient_key,
        idempotency_key, title, target_href, sent_by
      ) VALUES (
        ${candidateEventId}::uuid, ${definition.id}, ${resolved.recipient.userId}, ${resolved.recipient.userId ? null : resolved.recipient.email},
        ${resolved.recipientKey}, ${idempotencyKey}, ${presentation.title}, ${presentation.targetHref ?? null}, ${input.sentBy ?? null}
      )
      ON CONFLICT (definition_id, recipient_key, idempotency_key) DO NOTHING
      RETURNING id
    `;
    const createdId = eventRows[0]?.id;
    if (createdId) return { id: createdId, created: true, needsPreparation: true };

    const existing = await tx<{ id: string }[]>`
      SELECT id FROM notifications.events
      WHERE definition_id = ${definition.id} AND recipient_key = ${resolved.recipientKey}
        AND idempotency_key = ${idempotencyKey}
      FOR UPDATE
      LIMIT 1
    `;
    const eventId = existing[0]?.id;
    if (!eventId) throw new Error("Notification idempotency lookup failed");
    const [state] = await tx<{ delivery_count: number; preparation_failure_count: number }[]>`
      SELECT COUNT(*)::int AS delivery_count,
             COUNT(*) FILTER (WHERE status = 'failed' AND error_code = 'preparation_failed')::int AS preparation_failure_count
      FROM notifications.deliveries
      WHERE event_id = ${eventId}::uuid
    `;
    return {
      id: eventId,
      created: false,
      needsPreparation: Number(state?.delivery_count ?? 0) === 0 || Number(state?.preparation_failure_count ?? 0) > 0,
    };
  });

  if (!identity.needsPreparation) {
    return summarize(identity.id, identity.created, await listDeliveries(identity.id));
  }

  const event = { id: identity.id, definitionId: definition.id };
  let emailPresentationPromise: Promise<EmailNotificationPresentation | undefined> | undefined;
  const emailPresentation = (): Promise<EmailNotificationPresentation | undefined> => {
    emailPresentationPromise ??= definition.email ? Promise.resolve(definition.email(data, renderContext)) : Promise.resolve(undefined);
    return emailPresentationPromise;
  };

  const requiredPlans = (
    await Promise.all(
      requiredChannels.map((channel) =>
        prepareChannel({
          channel,
          recipient: resolved.recipient,
          presentation,
          emailPresentation,
          required: true,
          routePriority: null,
          event,
        }),
      ),
    )
  ).flat();
  const preferredPlans = (
    await Promise.all(
      preferred.map((channel, routePriority) =>
        prepareChannel({
          channel,
          recipient: resolved.recipient,
          presentation,
          emailPresentation,
          required: false,
          routePriority,
          event,
        }),
      ),
    )
  ).flat();

  if (requiredPlans.length === 0 && preferredPlans.length === 0) {
    preferredPlans.push({
      channel: "none",
      endpointId: null,
      destinationKey: "no-preferred-channel",
      destinationLabel: "No delivery channel",
      payloadEncrypted: null,
      required: false,
      routePriority: null,
      status: "suppressed",
      errorCode: preference.customized ? "disabled_by_user" : "no_preferred_channel",
      errorMessage: preference.customized
        ? "The user disabled delivery for this notification."
        : "No preferred delivery channel is configured.",
    });
  }

  const firstPreferredPriority = preferredPlans.find((delivery) => delivery.status === "deferred")?.routePriority;
  const plans = [
    ...requiredPlans.map((delivery) => ({ ...delivery, status: delivery.status === "deferred" ? ("pending" as const) : delivery.status })),
    ...preferredPlans.map((delivery) => ({
      ...delivery,
      status: delivery.status === "deferred" && delivery.routePriority === firstPreferredPriority ? ("pending" as const) : delivery.status,
    })),
  ];

  const persisted = await sql.begin(async (tx) => {
    await tx`SELECT id FROM notifications.events WHERE id = ${identity.id}::uuid FOR UPDATE`;
    const [state] = await tx<{ delivery_count: number; preparation_failure_count: number }[]>`
      SELECT COUNT(*)::int AS delivery_count,
             COUNT(*) FILTER (WHERE status = 'failed' AND error_code = 'preparation_failed')::int AS preparation_failure_count
      FROM notifications.deliveries
      WHERE event_id = ${identity.id}::uuid
    `;
    const shouldPrepare = Number(state?.delivery_count ?? 0) === 0 || Number(state?.preparation_failure_count ?? 0) > 0;
    if (!shouldPrepare) {
      return { prepared: false, pendingIds: [] as string[], requiredIds: [] as string[] };
    }
    await tx`
      DELETE FROM notifications.deliveries
      WHERE event_id = ${identity.id}::uuid AND status = 'failed' AND error_code = 'preparation_failed'
    `;
    await tx`
      UPDATE notifications.events
      SET title = ${presentation.title}, target_href = ${presentation.targetHref ?? null}
      WHERE id = ${identity.id}::uuid
    `;

    const pendingIds: string[] = [];
    const requiredIds: string[] = [];
    for (const delivery of plans) {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO notifications.deliveries (
          event_id, channel, endpoint_id, destination_key, destination_label,
          payload_encrypted, required, route_priority, status, next_attempt_at,
          error_code, error_message
        ) VALUES (
          ${identity.id}::uuid, ${delivery.channel}, ${delivery.endpointId}::uuid, ${delivery.destinationKey},
          ${delivery.destinationLabel}, ${delivery.payloadEncrypted}, ${delivery.required}, ${delivery.routePriority},
          ${delivery.status}, CASE WHEN ${delivery.status} = 'pending' THEN now() ELSE NULL END,
          ${delivery.errorCode}, ${delivery.errorMessage}
        )
        ON CONFLICT (event_id, channel, destination_key) DO NOTHING
        RETURNING id
      `;
      const deliveryId = rows[0]?.id;
      if (deliveryId && delivery.status === "pending") {
        if (delivery.required) requiredIds.push(deliveryId);
        else pendingIds.push(deliveryId);
      }
    }
    return { prepared: true, pendingIds, requiredIds };
  });

  if (persisted.prepared) {
    if (resolved.recipient.userId && (requiredChannelSet.has("browser") || preferred.includes("browser"))) {
      await notificationLive.publish({ userId: resolved.recipient.userId, eventId: identity.id, presentation });
    }
    for (const deliveryId of persisted.requiredIds) {
      const result = await processNotificationDelivery(deliveryId);
      if (result.status === "retry") await enqueueNotificationDelivery(deliveryId, result.retryAfterMs);
      if (result.activatedIds?.length) await enqueueNotificationDeliveries(result.activatedIds);
    }
    await enqueueNotificationDeliveries(persisted.pendingIds);
  }

  return summarize(identity.id, identity.created, await listDeliveries(identity.id));
};
