import type { NatsInventorySummary } from "./observability/nats/service";

export type SyncOperationalStatus = { status: "ok" | "warn" | "error"; signals: string[] };
export type SyncOperationalHealth = SyncOperationalStatus & {
  checkedAt: string;
  complete: boolean;
};

const raise = (result: SyncOperationalStatus, status: "warn" | "error", signal: string): void => {
  if (status === "error" || result.status === "ok") result.status = status;
  if (!result.signals.includes(signal)) result.signals.push(signal);
};

/** Broker metadata only: never reads payloads, creates consumers, or sums replica reports. */
export const buildSyncOperationalHealth = (
  inventory: NatsInventorySummary,
  appIds: readonly string[],
  namespace: string,
): { infrastructure: SyncOperationalHealth; apps: Map<string, SyncOperationalStatus> } => {
  const infrastructure: SyncOperationalHealth = {
    status: "ok",
    signals: [],
    checkedAt: inventory.sampledAt,
    complete: inventory.status === "available",
  };
  const apps = new Map<string, SyncOperationalStatus>(appIds.map((id) => [id, { status: "ok", signals: [] }]));
  if (!infrastructure.complete) raise(infrastructure, "warn", "Sync broker inventory is incomplete or unavailable");

  const seen = new Set<string>();
  for (const stream of inventory.streams) {
    if (seen.has(stream.name) || stream.sync?.namespace !== namespace) continue;
    seen.add(stream.name);
    const target = apps.get(stream.sync.owner) ?? infrastructure;
    if (stream.deadLetter && stream.messages > 0) {
      raise(target, "error", `Sync ${stream.sync.kind} ${stream.sync.id} has ${stream.messages} dead letters`);
    }
    if (stream.replicas > 1) {
      const cluster = stream.cluster;
      if (!cluster?.leader || cluster.replicas.some((replica) => replica.offline)) {
        raise(target, "error", `Sync ${stream.sync.kind} ${stream.sync.id} has unavailable stream replicas`);
      } else if (
        cluster.replicas.length < stream.replicas - 1 ||
        cluster.replicas.some((replica) => replica.current !== true || (replica.lag ?? 0) > 0)
      ) {
        raise(target, "warn", `Sync ${stream.sync.kind} ${stream.sync.id} has stream replicas catching up`);
      }
    }
  }
  return { infrastructure, apps };
};
