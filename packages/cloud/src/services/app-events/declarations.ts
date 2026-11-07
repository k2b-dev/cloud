import type { SQL } from "bun";
import { capabilityHash } from "../../_internal/capability-schemas";
import { appEventSubscriptionId } from "../../contracts/app-events";
import type { CapabilityRegistryEntry } from "../../contracts/registry";
import { audit } from "../audit";
import { toPgTextArray } from "../postgres";

export type StoredDeclaration = {
  app_id: string;
  type: string;
  version: number;
  subject: string;
  place: string | null;
  automation: boolean;
  title: string;
  description: string;
  data_schema: Record<string, unknown>;
  schema_hash: string;
  retired_at: Date | null;
};

type Transition = { id: string; previous_state: string; state: string; reason: string | null };
async function auditTransitions(tx: SQL, transitions: Transition[]) {
  for (const transition of transitions) {
    await audit.record(
      {
        action: "app_events.subscription.state_changed",
        outcome: "allowed",
        target: { type: "app_subscription", id: transition.id },
        metadata: { previousState: transition.previous_state, state: transition.state, reason: transition.reason },
      },
      tx,
    );
  }
}

export function createDeclarationSync(db: () => SQL, registry: () => Promise<CapabilityRegistryEntry[]>) {
  let previousSnapshot: string | undefined;
  let previousDatabase: SQL | undefined;
  let lastCheckedAt = -Infinity;
  let running: Promise<void> | undefined;

  async function sync(entries: CapabilityRegistryEntry[]) {
    await db().begin(async (tx) => {
      for (const entry of entries.toSorted((left, right) => left.appId.localeCompare(right.appId))) {
        const hash = capabilityHash({ events: entry.manifest.events ?? [], subscribes: entry.manifest.subscribes ?? [] });
        const [known] = await tx`SELECT hash FROM events.app_manifests WHERE app_id = ${entry.appId}`;
        if (known?.hash === hash) continue;
        // Serialize only replicas observing a changed manifest for this application.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`cloud.app-events:${entry.appId}`}))`;
        const [stored] = await tx`SELECT hash FROM events.app_manifests WHERE app_id = ${entry.appId}`;
        if (stored?.hash === hash) continue;
        const declared = (entry.manifest.events ?? []).map((event) => `${entry.appId}.${event.localId}@${event.version}`);
        await tx`
          UPDATE events.app_declarations SET retired_at = now()
          WHERE app_id = ${entry.appId} AND retired_at IS NULL
            AND NOT(type || '@' || version::text = ANY(${toPgTextArray(declared)}::text[]))
        `;
        for (const event of entry.manifest.events ?? []) {
          const type = `${entry.appId}.${event.localId}`;
          const schemaHash = event.schemaHash;
          await tx`
            INSERT INTO events.app_declarations (
              app_id, type, version, subject, place, automation, title, description, data_schema, schema_hash
            ) VALUES (
              ${entry.appId}, ${type}, ${event.version}, ${event.subject}, ${event.place ?? null},
              ${event.automation !== false}, ${event.title}, ${event.description},
              ${JSON.stringify(event.dataSchema)}::text::jsonb, ${schemaHash}
            ) ON CONFLICT(app_id, type, version) DO UPDATE SET
              subject = EXCLUDED.subject, place = EXCLUDED.place, automation = EXCLUDED.automation,
              title = EXCLUDED.title, description = EXCLUDED.description, data_schema = EXCLUDED.data_schema,
              schema_hash = EXCLUDED.schema_hash, retired_at = NULL
            WHERE (app_declarations.subject, app_declarations.place, app_declarations.automation,
              app_declarations.title, app_declarations.description, app_declarations.schema_hash)
              IS DISTINCT FROM (EXCLUDED.subject, EXCLUDED.place, EXCLUDED.automation,
                EXCLUDED.title, EXCLUDED.description, EXCLUDED.schema_hash)
              OR app_declarations.retired_at IS NOT NULL
          `;
        }
        const ids: string[] = [];
        for (const subscription of entry.manifest.subscribes ?? []) {
          const id = appEventSubscriptionId(entry.appId, subscription.type, subscription.version);
          ids.push(id);
          const inserted = await tx`
            INSERT INTO events.app_subscriptions(id, app_id, event_type, version, state, reason)
            VALUES (${id}, ${entry.appId}, ${subscription.type}, ${subscription.version}, 'blocked', 'event_not_declared')
            ON CONFLICT DO NOTHING RETURNING id
          `;
          if (inserted.length) {
            await audit.record(
              {
                action: "app_events.subscription.first_seen",
                outcome: "allowed",
                target: { type: "app_subscription", id },
                metadata: { appId: entry.appId, eventType: subscription.type, version: subscription.version },
              },
              tx,
            );
          } else {
            const restored = await tx<Transition[]>`
              WITH previous AS MATERIALIZED (
                SELECT id, state AS previous_state FROM events.app_subscriptions WHERE id = ${id} AND state = 'cancelled'
                FOR UPDATE
              ) UPDATE events.app_subscriptions subscription SET
                state = 'blocked', reason = 'event_not_declared', updated_at = now()
              FROM previous WHERE subscription.id = previous.id
              RETURNING subscription.id, previous.previous_state, subscription.state, subscription.reason
            `;
            await auditTransitions(tx, restored);
          }
        }
        const removed = await tx<Transition[]>`
          WITH previous AS MATERIALIZED (
            SELECT id, state AS previous_state FROM events.app_subscriptions
            WHERE app_id = ${entry.appId} AND NOT(id = ANY(${toPgTextArray(ids)}::text[])) AND state <> 'cancelled'
            ORDER BY id FOR UPDATE
          ) UPDATE events.app_subscriptions subscription SET
            state = 'cancelled', reason = 'subscription_removed', updated_at = now()
          FROM previous WHERE subscription.id = previous.id
          RETURNING subscription.id, previous.previous_state, subscription.state, subscription.reason
        `;
        await auditTransitions(tx, removed);
        if (removed.length) {
          await tx`
            UPDATE events.app_deliveries SET state = 'cancelled', code = 'subscription_removed',
              claimed_until = NULL, claim_token = NULL, updated_at = now()
            WHERE subscription_id = ANY(${toPgTextArray(removed.map(({ id }) => id))}::text[])
              AND state IN ('pending', 'retrying', 'failed')
          `;
        }
        await tx`
          INSERT INTO events.app_manifests(app_id, hash) VALUES (${entry.appId}, ${hash})
          ON CONFLICT(app_id) DO UPDATE SET hash = EXCLUDED.hash, updated_at = now()
          WHERE app_manifests.hash IS DISTINCT FROM EXCLUDED.hash
        `;
      }
      // A newly observed publisher can unblock an offline subscriber too.
      const transitions = await tx<Transition[]>`
        WITH desired AS MATERIALIZED (
          SELECT subscription.id, subscription.state AS previous_state,
            CASE WHEN declaration.type IS NULL THEN 'blocked'
              WHEN declaration.place IS NOT NULL THEN 'blocked' ELSE 'active' END AS state,
            CASE WHEN declaration.type IS NULL THEN 'event_not_declared'
              WHEN declaration.place IS NOT NULL THEN 'resource_events_unsupported' ELSE NULL END AS reason
          FROM events.app_subscriptions subscription
          LEFT JOIN events.app_declarations declaration ON declaration.type = subscription.event_type
            AND declaration.version = subscription.version
            AND declaration.app_id = split_part(subscription.event_type, '.', 1) AND declaration.retired_at IS NULL
          WHERE subscription.state <> 'cancelled'
            AND (subscription.state, subscription.reason) IS DISTINCT FROM (
              CASE WHEN declaration.type IS NULL OR declaration.place IS NOT NULL THEN 'blocked' ELSE 'active' END,
              CASE WHEN declaration.type IS NULL THEN 'event_not_declared'
                WHEN declaration.place IS NOT NULL THEN 'resource_events_unsupported' ELSE NULL END
            )
          ORDER BY subscription.id FOR UPDATE OF subscription
        ) UPDATE events.app_subscriptions subscription SET state = desired.state, reason = desired.reason, updated_at = now()
        FROM desired WHERE subscription.id = desired.id
          AND (subscription.state, subscription.reason) IS DISTINCT FROM (desired.state, desired.reason)
        RETURNING subscription.id, desired.previous_state, subscription.state, subscription.reason
      `;
      await auditTransitions(tx, transitions);
    });
  }

  async function reconcileSubscriptions(snapshot?: CapabilityRegistryEntry[]) {
    if (running) await running;
    const entries = snapshot ?? (await registry());
    const snapshotHash = capabilityHash(
      entries
        .map(({ appId, manifest }) => ({
          appId,
          events: manifest.events ?? [],
          subscribes: manifest.subscribes ?? [],
        }))
        .sort((left, right) => left.appId.localeCompare(right.appId)),
    );
    const database = db();
    if (database === previousDatabase && snapshotHash === previousSnapshot && performance.now() - lastCheckedAt < 30_000) return;
    running = sync(entries);
    try {
      await running;
      previousSnapshot = snapshotHash;
      previousDatabase = database;
      lastCheckedAt = performance.now();
    } finally {
      running = undefined;
    }
  }
  return { reconcileSubscriptions };
}
