import type { RootInfo } from "@k2b/filegate";
import type { RootSummary } from "../contracts";

/** Cached index totals and partial walks cannot stand in for observed root totals. */
export function rootSummary(info: RootInfo): RootSummary {
  const observed = info.stats?.complete === true && info.stats.freshness === "observed" ? info.stats : null;
  return {
    name: info.name,
    managed: info.managed,
    executionEnabled: info.execution,
    indexEnabled: info.index.enabled,
    versioningEnabled: info.versioning.enabled,
    files: observed?.files ?? null,
    directories: observed?.directories ?? null,
    bytes: observed?.bytes ?? null,
    observation: info.stats
      ? {
          complete: info.stats.complete,
          freshness: info.stats.freshness,
          source: info.stats.source,
          started: info.stats.started,
          completed: info.stats.completed,
          ...(info.stats.indexBuilt ? { indexBuilt: info.stats.indexBuilt } : {}),
        }
      : null,
    versions: info.versions,
    versionBytes: info.versionBytes,
    activeUploads: info.activeUploads,
    available: info.available,
    capacity: info.capacity,
  };
}
