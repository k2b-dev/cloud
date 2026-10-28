import { sql } from "bun";
import type { CapabilityEventCatalogEntry, CapabilityManifest } from "../contracts/capabilities";

export type CatalogSubscription = CapabilityEventCatalogEntry["subscribers"][number] & { eventType: string; version: number };

export const readCatalogSubscriptions = async (): Promise<CatalogSubscription[]> => {
  const rows = await sql<(Omit<CatalogSubscription, "firstSeenAt"> & { firstSeenAt: Date })[]>`
    SELECT app_id AS "appId", id AS "subscriptionId", event_type AS "eventType", version, state, reason,
      first_seen_at AS "firstSeenAt" FROM events.app_subscriptions ORDER BY id
  `;
  return rows.map((row) => ({ ...row, firstSeenAt: row.firstSeenAt.toISOString() }));
};

/** Callers filter persisted subscription states to applications their discovery surface may expose. */
export const projectAppEventCatalog = (
  manifest: CapabilityManifest,
  subscribers: readonly CatalogSubscription[],
): CapabilityEventCatalogEntry[] =>
  (manifest.events ?? []).map((event) => ({
    type: `${manifest.appId}.${event.localId}`,
    version: event.version,
    title: event.title,
    description: event.description,
    subject: `${manifest.appId}.${event.subject}`,
    place: event.place ? `${manifest.appId}.${event.place}` : null,
    automation: event.automation !== false,
    dataSchema: event.dataSchema,
    subscribers: subscribers
      .filter((subscription) => subscription.eventType === `${manifest.appId}.${event.localId}` && subscription.version === event.version)
      .map(({ eventType: _eventType, version: _version, ...subscription }) => subscription),
  }));
