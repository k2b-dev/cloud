import type { ActivityEntry } from "../activity-contracts";
import { apiClient } from "../api/client";
import type { FileEntry, FileVersion } from "../contracts";
import { apiFailure } from "./file-preview";
import { type ActivityVersion, isCurrent } from "./history-actions";
import { resolveTarget, restoreVersion } from "./history-api";

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
      const side = isCurrent(entry.after) ? entry.after : isCurrent(entry.before) ? entry.before : null;
      if (!side || side.directory || entry.state !== "done") return null;
      const resolved = await resolveTarget({ kind: "side", side }, fallback(), signal);
      if (!resolved.base.versioningEnabled || resolved.entry.directory) return null;
      const response = await apiClient.bases[":baseId"].versions.$get(
        { param: { baseId: resolved.base.id }, query: { path: resolved.entry.path } },
        { init: { signal } },
      );
      if (!response.ok) return apiFailure(response, fallback());
      const versions = await response.json();
      const value = activityVersion(entry, resolved.entry, versions);
      const saved = [...versions].sort((a, b) => a.created.localeCompare(b.created)).at(-1);
      if (!value?.restorable || !saved) return value;
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
