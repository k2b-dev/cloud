import type { TopicDeadLetter, TopicInventoryEntry } from "@k2b/sync";
import type { SQL } from "bun";
import { resolveCapabilityManifestPresentation } from "../../_internal/capabilities";
import type { AppEventEnvelope } from "../../contracts/app-events";
import type { CapabilityEventCatalogEntry } from "../../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../../contracts/registry";
import { type AuditActor, audit } from "../audit";
import type { StoredDeclaration } from "./declarations";

type Dependencies = {
  registry: () => Promise<CapabilityRegistryEntry[]>;
  deadLetters: (after?: string) => Promise<TopicDeadLetter<AppEventEnvelope>[]>;
  streams: () => AsyncIterable<Pick<TopicInventoryEntry, "id" | "firstSequence">>;
};
export function createEventAdministration(db: SQL, dependencies: Dependencies) {
  const catalog = async (locale = "en"): Promise<{ events: CapabilityEventCatalogEntry[] }> => {
    const [entries, declarations, storedSubscriptions] = await Promise.all([
      dependencies.registry(),
      db<StoredDeclaration[]>`SELECT * FROM events.app_declarations ORDER BY type, version`,
      db<
        {
          appId: string;
          subscriptionId: string;
          event_type: string;
          version: number;
          state: "active" | "blocked" | "cancelled";
          reason: string | null;
          firstSeenAt: Date;
        }[]
      >`
        SELECT app_id AS "appId", id AS "subscriptionId", event_type, version, state, reason, first_seen_at AS "firstSeenAt"
        FROM events.app_subscriptions ORDER BY id
      `,
    ]);
    return {
      events: declarations.map((declaration) => {
        const entry = entries.find(({ appId }) => appId === declaration.app_id);
        const presentation = entry
          ? resolveCapabilityManifestPresentation(entry.manifest, entry.presentation, locale).events?.find(
              (event) => `${entry.appId}.${event.localId}` === declaration.type && event.version === declaration.version,
            )
          : undefined;
        return {
          type: declaration.type,
          version: declaration.version,
          title: presentation?.title ?? declaration.title,
          description: presentation?.description ?? declaration.description,
          subject: `${declaration.app_id}.${declaration.subject}`,
          place: declaration.place ? `${declaration.app_id}.${declaration.place}` : null,
          automation: declaration.automation,
          dataSchema: declaration.data_schema,
          subscribers: storedSubscriptions
            .filter((subscription) => subscription.event_type === declaration.type && subscription.version === declaration.version)
            .map(({ event_type: _eventType, version: _version, firstSeenAt, ...subscription }) => ({
              ...subscription,
              firstSeenAt: firstSeenAt.toISOString(),
            })),
        };
      }),
    };
  };
  const subscriptions = async (app?: string) => {
    return {
      items: await db`
        SELECT subscription.id, subscription.app_id AS "appId", subscription.event_type AS "eventType", subscription.version,
          subscription.state, subscription.reason, subscription.first_seen_at AS "firstSeenAt",
          (SELECT jsonb_object_agg(state, count) FROM (
            SELECT state, count(*)::int AS count FROM events.app_deliveries
            WHERE subscription_id = subscription.id GROUP BY state
          ) counts) AS counts
        FROM events.app_subscriptions subscription
        WHERE (${app ?? null}::text IS NULL OR subscription.app_id = ${app ?? null}) ORDER BY subscription.id
      `,
    };
  };
  const deliveries = async (filter: { app?: string; state?: string; eventType?: string; offset?: number; limit?: number } = {}) => {
    const limit = Math.max(1, Math.min(100, filter.limit ?? 50));
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = await db`
      SELECT delivery.id, delivery.event_id AS "eventId", delivery.subscription_id AS "subscriptionId",
        subscription.app_id AS "appId", event.type AS "eventType", delivery.state, delivery.code, delivery.attempts,
        delivery.last_error AS "lastError", delivery.last_attempt_at AS "lastAttemptAt",
        delivery.next_attempt_at AS "nextAttemptAt", delivery.created_at AS "createdAt",
        (SELECT earlier.id FROM events.app_deliveries earlier
          WHERE earlier.subscription_id = delivery.subscription_id AND earlier.subject_key = delivery.subject_key
            AND earlier.seq < delivery.seq AND earlier.state IN ('pending', 'retrying', 'failed')
            AND delivery.state IN ('pending', 'retrying') ORDER BY earlier.seq LIMIT 1) AS "heldBy",
        count(*) OVER()::int AS total
      FROM events.app_deliveries delivery
      JOIN events.app_subscriptions subscription ON subscription.id = delivery.subscription_id
      JOIN events.app_events event ON event.id = delivery.event_id
      WHERE (${filter.app ?? null}::text IS NULL OR subscription.app_id = ${filter.app ?? null})
        AND (${filter.state ?? null}::text IS NULL OR delivery.state = ${filter.state ?? null})
        AND (${filter.eventType ?? null}::text IS NULL OR event.type = ${filter.eventType ?? null})
      ORDER BY delivery.seq DESC LIMIT ${limit} OFFSET ${offset}
    `;
    return {
      items: rows.map((row: Record<string, unknown>) => {
        const { total, ...item } = row;
        return item;
      }),
      pagination: { offset, limit, total: Number(rows[0]?.total ?? 0) },
    };
  };
  const redeliver = async (id: string, actor: AuditActor) =>
    db.begin(async (tx) => {
      const changed = await tx`
        UPDATE events.app_deliveries delivery SET state = 'pending', code = NULL, last_error = NULL,
          attempts = 0, unreachable_count = 0, next_attempt_at = now(), claimed_until = NULL, claim_token = NULL, updated_at = now()
        WHERE delivery.id = ${id}::uuid AND delivery.state IN ('failed', 'cancelled', 'done')
          AND EXISTS(SELECT FROM events.app_subscriptions subscription
            WHERE subscription.id = delivery.subscription_id AND subscription.state = 'active')
          AND EXISTS(SELECT FROM events.app_events event WHERE event.id = delivery.event_id AND event.state = 'accepted')
        RETURNING event_id AS "eventId", id
      `;
      if (!changed.length) return null;
      await audit.record(
        {
          action: "app_events.delivery.redeliver",
          outcome: "allowed",
          actor,
          target: { type: "app_delivery", id },
          metadata: { eventId: changed[0]?.eventId },
        },
        tx,
      );
      return changed[0];
    });

  const status = async () => {
    const [stored] = await db`
      SELECT state, code, last_sequence AS "lastSequence", gap_from AS "gapFrom", gap_to AS "gapTo", updated_at AS "updatedAt"
      FROM events.app_broker_status WHERE id = true
    `;
    const deadLetters = await dependencies.deadLetters();
    return {
      ...stored,
      deadLetters: deadLetters.map(({ messageId, eventId, consumer, attempts, failedAt, reason }) => ({
        messageId,
        eventId,
        consumer,
        attempts,
        failedAt,
        reason,
      })),
      deadLetterLimit: 100,
    };
  };
  const checkGap = async () => {
    const [stored] = await db<{ last_sequence: string }[]>`
      SELECT last_sequence FROM events.app_broker_status WHERE id = true
    `;
    let position = Number(stored?.last_sequence ?? 0);
    const seen = new Set<number>();
    const deadline = performance.now() + 30_000;
    let after: string | undefined;
    while (true) {
      if (performance.now() >= deadline) return;
      const page = await dependencies.deadLetters(after);
      for (const deadLetter of page) {
        if (deadLetter.consumer === "core-app-events-v1" && deadLetter.event) seen.add(deadLetter.event.sequence);
      }
      if (page.length < 100) break;
      const next = page.at(-1)?.messageId;
      if (!next || next === after) return;
      after = next;
    }
    while (seen.has(position + 1)) position++;
    await db`
      UPDATE events.app_broker_status SET last_sequence = ${position}, updated_at = now()
      WHERE id = true AND last_sequence < ${position}
    `;
    for await (const stream of dependencies.streams()) {
      if (stream.id !== "cloud:app-events") continue;
      await db`
        UPDATE events.app_broker_status SET state = 'gap_detected', code = 'reconcile_required',
          gap_from = COALESCE(gap_from, last_sequence + 1), gap_to = ${stream.firstSequence - 1}, updated_at = now()
        WHERE id = true AND last_sequence + 1 < ${stream.firstSequence}
          AND (state <> 'gap_detected' OR gap_to IS DISTINCT FROM ${stream.firstSequence - 1}::bigint)
      `;
      break;
    }
  };
  const acknowledgeGap = async (actor: AuditActor) =>
    db.begin(async (tx) => {
      const [previous] = await tx`
        SELECT state, gap_from, gap_to FROM events.app_broker_status WHERE id = true FOR UPDATE
      `;
      if (previous?.state !== "gap_detected") return null;
      const [result] = await tx`
        UPDATE events.app_broker_status SET state = 'ready', code = NULL,
          last_sequence = GREATEST(last_sequence, gap_to), gap_from = NULL, gap_to = NULL, updated_at = now()
        WHERE id = true RETURNING state, last_sequence AS "lastSequence"
      `;
      await audit.record(
        {
          action: "app_events.gap.acknowledge",
          outcome: "allowed",
          actor,
          target: { type: "app_event_broker", id: "core-app-events-v1" },
          metadata: { gapFrom: previous.gap_from, gapTo: previous.gap_to },
        },
        tx,
      );
      return result;
    });
  const retain = async () =>
    db.begin(async (tx) => {
      await tx`
        UPDATE events.app_deliveries SET state = 'cancelled', code = 'retention_expired',
          claimed_until = NULL, claim_token = NULL, updated_at = now()
        WHERE id IN (
          SELECT id FROM events.app_deliveries
          WHERE state IN ('pending', 'retrying', 'failed') AND created_at < now() - interval '30 days' LIMIT 1000
        )
      `;
      await tx`
        DELETE FROM events.app_deliveries WHERE id IN (
          SELECT id FROM events.app_deliveries
          WHERE state IN ('done', 'cancelled') AND updated_at < now() - interval '7 days' LIMIT 1000
        )
      `;
      await tx`
        DELETE FROM events.app_events WHERE id IN (
          SELECT event.id FROM events.app_events event
          WHERE received_at < now() - interval '30 days'
            AND NOT EXISTS(SELECT FROM events.app_deliveries delivery WHERE delivery.event_id = event.id) LIMIT 1000
        )
      `;
    });
  return { catalog, subscriptions, deliveries, redeliver, status, checkGap, acknowledgeGap, retain };
}
