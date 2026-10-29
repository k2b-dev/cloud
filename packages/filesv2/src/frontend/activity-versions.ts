import type { ActivityEntry, ActivitySide } from "../activity-contracts";
import { apiClient } from "../api/client";
import type { FileEntry, FileVersion } from "../contracts";
import { stableEntryRefId } from "../resource-ref";
import { apiFailure } from "./file-preview";
import type { ActivityVersion, FullSide } from "./history-actions";
import { restoreVersion } from "./history-api";

/** Exact version IDs and the current revision are evidence; timestamps and revision strings are not version IDs. */
export function activityVersion(entry: ActivityEntry, file: FileEntry, versions: readonly FileVersion[]): ActivityVersion | null {
  const ordered = [...versions].sort((a, b) => a.created.localeCompare(b.created));
  const side = entry.after.visibility === "full" ? entry.after : entry.before.visibility === "full" ? entry.before : null;
  const index = side?.versionId ? ordered.findIndex((version) => version.id === side.versionId) : -1;
  if (index >= 0) return { current: index + 1, restorable: null };
  if (
    entry.state !== "done" ||
    (entry.action !== "file.overwrite" && entry.action !== "file.edit") ||
    entry.after.visibility !== "full" ||
    !entry.after.revision ||
    entry.after.revision !== file.revision
  )
    return null;
  return { current: ordered.length + 1, restorable: ordered.length > 0 && file.actions?.write !== false ? ordered.length : null };
}

/** One workspace serializes these supplementary reads, leaving its normal list/navigation requests independent. */
export function createActivityVersionLoader(fallback: () => string) {
  let previous: Promise<unknown> = Promise.resolve();
  return (entry: ActivityEntry, signal: AbortSignal): Promise<ActivityVersion | null> => {
    const result = previous.then(async () => {
      signal.throwIfAborted();
      const addressable = (side: ActivitySide): side is FullSide & { publicBaseId: string } =>
        side.visibility === "full" && side.publicBaseId !== null && (side.itemId !== null || side.relativePath != null);
      const side = addressable(entry.after) ? entry.after : addressable(entry.before) ? entry.before : null;
      if (!side || side.directory || entry.state !== "done") return null;
      // Own/admin snapshots only provide an address to check. The normal reader authorizes that item afresh.
      const stable = side.itemId ? stableEntryRefId(side.publicBaseId, side.itemId) : null;
      if (!stable && side.relativePath == null) return null;
      const readItem = async () => {
        const response = stable
          ? await apiClient.entries[":id"].$get({ param: { id: stable } }, { init: { signal } })
          : await apiClient.bases[":baseId"].entry.$get(
              { param: { baseId: side.publicBaseId }, query: { path: side.relativePath! } },
              { init: { signal } },
            );
        if (Number(response.status) === 403 || Number(response.status) === 404) return null;
        if (!response.ok) return apiFailure(response, fallback());
        return response.json();
      };
      const resolved = await readItem();
      if (!resolved || !resolved.base.versioningEnabled || resolved.entry.directory) return null;
      const response = await apiClient.bases[":baseId"].versions.$get(
        { param: { baseId: resolved.base.id }, query: { path: resolved.entry.path } },
        { init: { signal } },
      );
      if (Number(response.status) === 403 || Number(response.status) === 404) return null;
      if (!response.ok) return apiFailure(response, fallback());
      const versions = await response.json();
      const value = activityVersion(entry, resolved.entry, versions);
      if (!value) return null;
      const confirmed = await readItem();
      if (
        !confirmed ||
        confirmed.base.id !== resolved.base.id ||
        confirmed.entry.path !== resolved.entry.path ||
        confirmed.entry.revision !== resolved.entry.revision ||
        (confirmed.entry.resourceId ?? confirmed.resourceId) !== (resolved.entry.resourceId ?? resolved.resourceId)
      )
        return null;
      const saved = [...versions].sort((a, b) => a.created.localeCompare(b.created)).at(-1);
      if (!value.restorable || !saved) return value;
      return {
        ...value,
        // The mutation checks current rights and expectedRevision again; a stale row cannot overwrite new content.
        restore: async () => {
          await restoreVersion(resolved.base.id, resolved.entry, saved.id, fallback());
        },
      };
    });
    previous = result.catch(() => {});
    return result;
  };
}
