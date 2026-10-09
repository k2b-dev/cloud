import { sql } from "bun";
import { z } from "zod";
import { decryptSecret } from "../secrets";
import { getNotificationChannel } from "./channels";
import { quietStateForEvent } from "./quiet";

const MAX_DELIVERY_ATTEMPTS = 5;
const BASE_RETRY_MS = 2_000;
const MAX_RETRY_MS = 5 * 60_000;

type DeliveryRow = {
  id: string;
  event_id: string;
  channel: string;
  payload_encrypted: string | null;
  required: boolean;
  route_priority: number | null;
  attempt_count: number;
  outgoing_mail_id: string | null;
};

export type DeliveryAttemptResult =
  | { status: "skipped" | "delivered" | "suppressed" | "failed" }
  | { status: "pending"; retryAfterMs: number }
  | { status: "retry"; retryAfterMs: number; error: string };

const retryDelay = (attempt: number): number => Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempt - 1), MAX_RETRY_MS);

/**
 * Do not disturb and quiet hours hold back recommended browser notifications when they would go out. The
 * notification is dropped, not postponed, so nothing arrives in a burst when the quiet time ends, and it is not
 * rerouted: the event's waiting fallbacks end with it. Required deliveries are part of a protocol and still go.
 */
const holdBackForQuietTime = async (delivery: DeliveryRow): Promise<boolean> => {
  if (delivery.channel !== "browser" || delivery.required) return false;
  const quiet = await quietStateForEvent(delivery.event_id);
  if (!quiet?.active) return false;
  const code = quiet.reason === "doNotDisturb" ? "do_not_disturb" : "quiet_hours";
  const message = quiet.reason === "doNotDisturb" ? "Held back by do not disturb." : "Held back during quiet hours.";
  await sql`
    UPDATE notifications.deliveries
    SET status = 'suppressed', attempt_count = attempt_count - 1, next_attempt_at = NULL,
        error_code = ${code}, error_message = ${message}, payload_encrypted = NULL, updated_at = now()
    WHERE id = ${delivery.id}::uuid AND status = 'sending'
  `;
  await sql`
    UPDATE notifications.deliveries
    SET status = 'suppressed', error_code = ${code}, error_message = ${message}, payload_encrypted = NULL, updated_at = now()
    WHERE event_id = ${delivery.event_id}::uuid AND required = false AND status = 'deferred'
  `;
  return true;
};

const activateNextFallback = async (eventId: string): Promise<string[]> => {
  const delivered = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM notifications.deliveries
      WHERE event_id = ${eventId}::uuid AND required = false AND status = 'delivered'
    ) AS exists
  `;
  if (delivered[0]?.exists) {
    await sql`
      UPDATE notifications.deliveries
      SET status = 'suppressed', error_code = 'fallback_not_needed',
          error_message = 'A preferred channel was delivered.', payload_encrypted = NULL, updated_at = now()
      WHERE event_id = ${eventId}::uuid AND required = false AND status = 'deferred'
    `;
    return [];
  }

  const active = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM notifications.deliveries
      WHERE event_id = ${eventId}::uuid AND required = false AND status IN ('pending', 'sending')
    ) AS exists
  `;
  if (active[0]?.exists) return [];

  const rows = await sql<{ id: string }[]>`
    WITH next_route AS (
      SELECT MIN(route_priority) AS priority
      FROM notifications.deliveries
      WHERE event_id = ${eventId}::uuid AND required = false AND status = 'deferred'
    )
    UPDATE notifications.deliveries d
    SET status = 'pending', next_attempt_at = now(), updated_at = now()
    FROM next_route
    WHERE d.event_id = ${eventId}::uuid
      AND d.required = false
      AND d.status = 'deferred'
      AND d.route_priority = next_route.priority
    RETURNING d.id
  `;
  return rows.map((row) => row.id);
};

export const processNotificationDelivery = async (
  deliveryId: string,
  signal?: AbortSignal,
): Promise<DeliveryAttemptResult & { activatedIds?: string[] }> => {
  const rows = await sql<DeliveryRow[]>`
    UPDATE notifications.deliveries
    SET status = 'sending', attempt_count = attempt_count + 1,
        last_attempt_at = now(), updated_at = now()
    WHERE id = ${deliveryId}::uuid
      AND status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    RETURNING id, event_id, channel, payload_encrypted, required, route_priority, attempt_count, outgoing_mail_id
  `;
  const delivery = rows[0];
  if (!delivery) return { status: "skipped" };

  try {
    if (await holdBackForQuietTime(delivery)) return { status: "suppressed" };
    const driver = getNotificationChannel(delivery.channel);
    if (!driver)
      throw Object.assign(new Error(`Notification channel "${delivery.channel}" is unavailable`), { code: "channel_unavailable" });
    if (!delivery.payload_encrypted) {
      throw Object.assign(new Error("Notification delivery payload is unavailable"), { code: "payload_missing", retryable: false });
    }
    const payload = await decryptSecret(delivery.payload_encrypted);
    const outcome = await driver.deliver(payload, {
      deliveryId: delivery.id,
      ...(signal ? { signal } : {}),
      ...(delivery.outgoing_mail_id ? { outgoingMailId: delivery.outgoing_mail_id } : {}),
    });
    // Third-party drivers may return provider bodies; only a UUID can name an outgoing mail.
    const mailId = z.uuid().safeParse(outcome?.outgoingMailId).data ?? null;
    if (
      outcome?.status === "pending" &&
      typeof outcome.retryAfterMs === "number" &&
      Number.isFinite(outcome.retryAfterMs) &&
      outcome.retryAfterMs > 0
    ) {
      const retryAfterMs = Math.round(Math.min(MAX_RETRY_MS, Math.max(BASE_RETRY_MS, outcome.retryAfterMs)));
      await sql`
        UPDATE notifications.deliveries
        SET status = 'pending', attempt_count = attempt_count - 1,
            next_attempt_at = now() + (${retryAfterMs}::int * INTERVAL '1 millisecond'),
            outgoing_mail_id = COALESCE(${mailId}::uuid, outgoing_mail_id),
            error_code = NULL, error_message = ${typeof outcome.errorMessage === "string" ? outcome.errorMessage : null}, updated_at = now()
        WHERE id = ${delivery.id}::uuid
      `;
      return { status: "pending", retryAfterMs };
    }
    await sql`
      UPDATE notifications.deliveries
      SET outgoing_mail_id = COALESCE(${mailId}::uuid, outgoing_mail_id),
          status = 'delivered', delivered_at = now(), next_attempt_at = NULL,
          error_code = NULL, error_message = NULL, payload_encrypted = NULL, updated_at = now()
      WHERE id = ${delivery.id}::uuid
    `;
    const activatedIds = delivery.required ? [] : await activateNextFallback(delivery.event_id);
    return { status: "delivered", activatedIds };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Notification delivery failed";
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "provider_error";
    const outgoingMailId =
      error && typeof error === "object" && "outgoingMailId" in error ? (z.uuid().safeParse(error.outgoingMailId).data ?? null) : null;
    const retryable = !(error && typeof error === "object" && "retryable" in error && error.retryable === false);
    if (retryable && delivery.attempt_count < MAX_DELIVERY_ATTEMPTS) {
      const retryAfterMs = retryDelay(delivery.attempt_count);
      await sql`
        UPDATE notifications.deliveries
        SET status = 'pending', next_attempt_at = now() + (${retryAfterMs}::int * INTERVAL '1 millisecond'),
            error_code = ${code}, error_message = ${message}, updated_at = now()
        WHERE id = ${delivery.id}::uuid
      `;
      return { status: "retry", retryAfterMs, error: message };
    }

    await sql`
      UPDATE notifications.deliveries
      SET outgoing_mail_id = COALESCE(${outgoingMailId}::uuid, outgoing_mail_id),
          status = 'failed', next_attempt_at = NULL, error_code = ${code},
          error_message = ${message}, payload_encrypted = NULL, updated_at = now()
      WHERE id = ${delivery.id}::uuid
    `;
    const activatedIds = delivery.required ? [] : await activateNextFallback(delivery.event_id);
    return { status: "failed", activatedIds };
  }
};

export const recoverNotificationDeliveries = async (): Promise<string[]> => {
  await sql`
    UPDATE notifications.deliveries
    SET status = 'pending', next_attempt_at = now(), error_code = 'lease_recovered',
        error_message = 'Recovered an interrupted delivery attempt.', updated_at = now()
    WHERE status = 'sending' AND last_attempt_at < now() - INTERVAL '5 minutes'
  `;
  const rows = await sql<{ id: string }[]>`
    SELECT id
    FROM notifications.deliveries
    WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    ORDER BY next_attempt_at NULLS FIRST, created_at
    LIMIT 500
  `;
  return rows.map((row) => row.id);
};

export const reconcileNotificationMessages = async (): Promise<void> => {
  await sql`
    WITH terminal AS (
      SELECT m.id, m.outgoing_mail_id, mail.status, mail.sent_at,
        COALESCE(mail.error_message, mail.smtp_response, 'Outgoing mail record is no longer available.') AS error
      FROM notifications.messages m
      LEFT JOIN outgoing_mail.messages mail ON mail.id = m.outgoing_mail_id
      WHERE m.outgoing_mail_id IS NOT NULL AND m.sent_at IS NULL AND m.error IS NULL
        AND (mail.status IN ('sent', 'bounced', 'failed', 'cancelled') OR mail.id IS NULL)
      ORDER BY m.outgoing_mail_id, m.id LIMIT 500
    )
    UPDATE notifications.messages m
    SET sent_at = CASE WHEN t.status IN ('sent', 'bounced') THEN t.sent_at ELSE NULL END,
        error = CASE WHEN t.status IN ('sent', 'bounced') THEN NULL ELSE t.error END
    FROM terminal t
    WHERE m.id = t.id AND m.outgoing_mail_id = t.outgoing_mail_id AND m.sent_at IS NULL AND m.error IS NULL
  `;
};
