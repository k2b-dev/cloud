import { lifecycleStorageWarning } from "./observability/nats/capacity";
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
    const lifecycle = stream.sharedTextLifecycle;
    if (seen.has(stream.name) || (stream.sync?.namespace ?? lifecycle?.namespace) !== namespace) continue;
    seen.add(stream.name);
    const target = (stream.sync && apps.get(stream.sync.owner)) || infrastructure;
    const label = stream.sync ? `Sync ${stream.sync.kind} ${stream.sync.id}` : `Shared text lifecycle ${lifecycle!.id}`;
    if (lifecycleStorageWarning(stream))
      raise(
        target,
        "warn",
        `${label} storage is ${Math.floor((stream.bytes / stream.maxBytes) * 100)}% full (${stream.bytes}/${stream.maxBytes} bytes); increase its byte budget before it fills`,
      );
    if (stream.deadLetter && stream.messages > 0) {
      raise(target, "error", `${label} has ${stream.messages} dead letters`);
    }
    if (stream.replicas > 1) {
      const cluster = stream.cluster;
      if (!cluster?.leader || cluster.replicas.some((replica) => replica.offline)) {
        raise(target, "error", `${label} has unavailable stream replicas`);
      } else if (
        cluster.replicas.length < stream.replicas - 1 ||
        cluster.replicas.some((replica) => replica.current !== true || (replica.lag ?? 0) > 0)
      ) {
        raise(target, "warn", `${label} has stream replicas catching up`);
      }
    }
  }
  return { infrastructure, apps };
};
