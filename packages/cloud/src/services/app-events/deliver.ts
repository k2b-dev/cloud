import type { SQL } from "bun";
import type { getCapability } from "../../_internal/registry";
import type { AppEventEnvelope } from "../../contracts/app-events";
import { audit } from "../audit";
import { signAppEventInvocation } from "../identity/invocation-token";
import { toPgTextArray } from "../postgres";

export const APP_EVENT_DELIVERY_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000] as const;
export const APP_EVENT_DELIVERY_ATTEMPTS = APP_EVENT_DELIVERY_BACKOFF_MS.length + 1;
const BATCH_SIZE = 32;
const CONCURRENCY = 4;
// The subscriber has 30 seconds to answer before Core ends the request.
const DELIVERY_TIMEOUT_MS = 45_000;
type Delivery = {
  id: string;
  event_id: string;
  subscription_id: string;
  attempts: number;
  unreachable_count: number;
  claim_token: string;
  envelope: AppEventEnvelope;
  app_id: string;
};
type Dependencies = {
  fetch?: typeof fetch;
  sign?: typeof signAppEventInvocation;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);
async function auditFailure(tx: SQL, row: Delivery, code: string | null) {
  await audit.record(
    {
      action: "app_events.delivery.failed",
      outcome: "failed",
      target: { type: "app_delivery", id: row.id },
      error: { code: code ?? "handler_failed" },
      metadata: { eventId: row.event_id, subscriptionId: row.subscription_id, attempts: row.attempts },
    },
    tx,
  );
}

export function createEventDelivery(
  db: SQL,
  findApp: typeof getCapability,
  reconcileSubscriptions: () => Promise<void>,
  dependencies: Dependencies,
) {
  async function postpone(row: Delivery) {
    const delay = Math.min(30_000 * 2 ** Math.min(row.unreachable_count, 7), 3_600_000);
    await db`
      UPDATE events.app_deliveries SET state = 'retrying', code = 'subscriber_unreachable', attempts = attempts - 1,
        unreachable_count = unreachable_count + 1, claimed_until = NULL, claim_token = NULL,
        next_attempt_at = now() + ${delay} * interval '1 millisecond', updated_at = now()
      WHERE id = ${row.id}::uuid AND claim_token = ${row.claim_token}::uuid AND state IN ('pending', 'retrying')
    `;
  }
  const claim = async () =>
    db.begin(async (tx) => {
      const exhausted = await tx<Delivery[]>`
        UPDATE events.app_deliveries SET state = 'failed', code = 'attempts_exhausted',
          claimed_until = NULL, claim_token = NULL, updated_at = now()
        WHERE id IN (
          SELECT id FROM events.app_deliveries WHERE state IN ('pending', 'retrying')
            AND attempts >= ${APP_EVENT_DELIVERY_ATTEMPTS} AND (claimed_until IS NULL OR claimed_until <= now())
          ORDER BY seq LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
        ) RETURNING *
      `;
      for (const delivery of exhausted) await auditFailure(tx, delivery, "attempts_exhausted");
      const rows = await tx<Delivery[]>`
        WITH candidates AS MATERIALIZED (
          SELECT delivery.id FROM events.app_deliveries delivery
          JOIN events.app_subscriptions subscription ON subscription.id = delivery.subscription_id
          WHERE delivery.state IN ('pending', 'retrying') AND delivery.next_attempt_at <= now()
            AND (delivery.claimed_until IS NULL OR delivery.claimed_until <= now())
            AND delivery.attempts < ${APP_EVENT_DELIVERY_ATTEMPTS} AND subscription.state = 'active'
            AND NOT EXISTS (
              SELECT FROM events.app_deliveries earlier
              WHERE earlier.subscription_id = delivery.subscription_id AND earlier.subject_key = delivery.subject_key
                AND earlier.seq < delivery.seq AND earlier.state IN ('pending', 'retrying', 'failed')
            )
          ORDER BY delivery.seq LIMIT ${CONCURRENCY} FOR UPDATE OF delivery SKIP LOCKED
        ) UPDATE events.app_deliveries delivery SET claimed_until = now() + interval '60 seconds',
          claim_token = gen_random_uuid(), attempts = delivery.attempts + 1, last_attempt_at = now(), updated_at = now()
        FROM candidates WHERE delivery.id = candidates.id RETURNING delivery.*
      `;
      if (!rows.length) return [];
      return tx<Delivery[]>`
        SELECT delivery.*, subscription.app_id, event.envelope
        FROM events.app_deliveries delivery
        JOIN events.app_subscriptions subscription ON subscription.id = delivery.subscription_id
        JOIN events.app_events event ON event.id = delivery.event_id
        WHERE delivery.id = ANY(${toPgTextArray(rows.map((row) => row.id))}::uuid[]) ORDER BY delivery.seq
      `;
    });

  const finish = async (
    row: Delivery,
    state: "done" | "cancelled" | "retrying" | "failed",
    code: string | null,
    error: string | null = null,
  ) =>
    db.begin(async (tx) => {
      const delay = APP_EVENT_DELIVERY_BACKOFF_MS[Math.min(row.attempts - 1, APP_EVENT_DELIVERY_BACKOFF_MS.length - 1)] ?? 0;
      const changed = await tx`
        UPDATE events.app_deliveries SET state = ${state}, code = ${code}, last_error = ${error},
          claimed_until = NULL, claim_token = NULL, unreachable_count = 0,
          next_attempt_at = now() + ${delay} * interval '1 millisecond', updated_at = now()
        WHERE id = ${row.id}::uuid AND claim_token = ${row.claim_token}::uuid AND state IN ('pending', 'retrying')
        RETURNING id
      `;
      if (state === "done" && changed.length) {
        await tx`
          UPDATE events.app_deliveries delivery SET next_attempt_at = now(), unreachable_count = 0, updated_at = now()
          FROM events.app_subscriptions subscription
          WHERE subscription.id = delivery.subscription_id AND subscription.app_id = ${row.app_id}
            AND delivery.state = 'retrying' AND delivery.code = 'subscriber_unreachable'
            AND delivery.claim_token IS NULL AND delivery.next_attempt_at > now()
        `;
      }
      if (state === "failed" && changed.length) await auditFailure(tx, row, code);
    });

  const deliver = async (row: Delivery) => {
    try {
      const [subscription] = await db`
        SELECT state, reason FROM events.app_subscriptions WHERE id = ${row.subscription_id}
      `;
      if (subscription?.state === "cancelled") {
        await finish(row, "cancelled", "subscription_removed");
        return;
      }
      if (subscription?.state !== "active") {
        // A declaration transition can block a subscription after this delivery was claimed.
        await db`
          UPDATE events.app_deliveries SET state = 'retrying', code = ${subscription?.reason ?? "subscription_blocked"},
            attempts = attempts - 1, claimed_until = NULL, claim_token = NULL, next_attempt_at = now(), updated_at = now()
          WHERE id = ${row.id}::uuid AND claim_token = ${row.claim_token}::uuid AND state IN ('pending', 'retrying')
        `;
        return;
      }
      const app = await findApp(row.app_id);
      if (!app) {
        await postpone(row);
        return;
      }
      if (row.envelope.place) {
        await finish(row, "failed", "resource_events_unsupported");
        return;
      }
      const payload = { envelope: row.envelope, subscriptionId: row.subscription_id, attempt: row.attempts };
      const token = await (dependencies.sign ?? signAppEventInvocation)({
        appId: row.app_id,
        subscriptionId: row.subscription_id,
        eventId: row.event_id,
        payload,
      });
      const url = new URL("/api/_internal/events/v1/deliver", app.endpoint);
      let response: Response;
      try {
        response = await (dependencies.fetch ?? fetch)(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        // Only errors that prove no request reached the subscriber refund an attempt.
        if (["ConnectionRefused", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(String(code))) {
          await postpone(row);
        } else {
          await finish(
            row,
            row.attempts >= APP_EVENT_DELIVERY_ATTEMPTS ? "failed" : "retrying",
            error instanceof Error && error.name === "TimeoutError" ? "handler_timeout" : "connection_lost",
            message(error),
          );
        }
        return;
      }
      if (response.ok) {
        await finish(row, "done", null);
        return;
      }
      if (response.status === 422) {
        await finish(row, "failed", "schema_mismatch");
        return;
      }
      if (response.status === 410) {
        await finish(row, row.attempts >= APP_EVENT_DELIVERY_ATTEMPTS ? "failed" : "retrying", "subscription_unavailable");
        return;
      }
      throw new Error(`Subscriber returned HTTP ${response.status}`);
    } catch (error) {
      await finish(
        row,
        row.attempts >= APP_EVENT_DELIVERY_ATTEMPTS ? "failed" : "retrying",
        row.attempts >= APP_EVENT_DELIVERY_ATTEMPTS ? "attempts_exhausted" : "handler_failed",
        message(error),
      );
    }
  };

  const work = async () => {
    await reconcileSubscriptions();
    let total = 0;
    for (let batch = 0; batch < BATCH_SIZE / CONCURRENCY; batch++) {
      const rows = await claim();
      await Promise.all(rows.map(deliver));
      total += rows.length;
      if (!rows.length) break;
    }
    return total;
  };

  return { claim, deliver, work };
}
