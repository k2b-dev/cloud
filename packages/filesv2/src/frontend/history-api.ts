import type { ActivityEntry } from "../activity-contracts";
import { apiClient } from "../api/client";
import { type EntryResult, ErrorSchema, type FileEntry, type ShareView } from "../contracts";
import { stableEntryRefId } from "../resource-ref";
import type { ActivityRequest } from "./ActivityView";
import { apiFailure } from "./file-preview";
import type { HistoryTarget, RestoreOutcome } from "./history-actions";
import type { ItemHistoryRequest } from "./history-requests";
import type { ShareAccessRequest } from "./ShareHistory";
import { filesUrl } from "./urls";

/*
 * Browser calls of the history reader and the existing action endpoints. Every call is checked again on the server;
 * a stored history entry is never used as authority for a place.
 */

export async function loadActivity(request: ActivityRequest & { cursor?: string }, signal: AbortSignal, fallback: string) {
  const response = await apiClient.activity.$get({ query: request }, { init: { signal } });
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

export async function loadItemHistory(request: ItemHistoryRequest, cursor: string | null, signal: AbortSignal, fallback: string) {
  return loadActivity({ ...request, ...(cursor ? { cursor } : {}) }, signal, fallback);
}

export async function loadChain(entry: ActivityEntry, signal: AbortSignal, fallback: string, oldPath?: string) {
  const response = await apiClient.activity[":activityId"].chain.$get(
    { param: { activityId: entry.id }, query: oldPath === undefined ? {} : { oldPath } },
    { init: { signal } },
  );
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

export async function loadShareAccess(
  request: ShareAccessRequest,
  period: { from: string; to: string },
  signal: AbortSignal,
  fallback: string,
) {
  const response = await apiClient.shares[":shareId"].access.$get(
    {
      param: { shareId: request.shareId },
      query: {
        ...period,
        ...(request.networkAfter ? { networkAfter: request.networkAfter } : {}),
        ...(request.timelineAfter ? { timelineAfter: request.timelineAfter } : {}),
      },
    },
    { init: { signal } },
  );
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

/** One authorized page for this current item; the service decides creator/admin visibility and management. */
export async function loadItemShares(
  request: { baseId: string; path: string },
  after: string | null,
  signal: AbortSignal,
  fallback: string,
) {
  const response = await apiClient.shares.$get({ query: { ...request, ...(after ? { after } : {}) } }, { init: { signal } });
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

export async function revokeShare(share: ShareView, fallback: string) {
  const response =
    share.managementMode === "admin"
      ? await apiClient.admin.shares[":id"].revoke.$post({ param: { id: share.id } })
      : await apiClient.shares[":id"].revoke.$post({ param: { id: share.id } });
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

/**
 * Resolves a history target to the item where it is now, with the person's current rights: a stable ID through
 * `/entries/:id`, a base-relative path through the entry endpoint. The reader marks only fresh sides as targets.
 */
export async function resolveTarget(target: HistoryTarget, fallback: string, signal?: AbortSignal): Promise<EntryResult> {
  const stable =
    target.kind === "side"
      ? target.side.itemId && stableEntryRefId(target.side.publicBaseId, target.side.itemId)
      : target.endpoint.itemId && stableEntryRefId(target.endpoint.baseId, target.endpoint.itemId);
  if (stable) {
    const response = await apiClient.entries[":id"].$get({ param: { id: stable } }, { init: { signal } });
    if (!response.ok) return apiFailure(response, fallback);
    return response.json();
  }
  const place =
    target.kind === "endpoint"
      ? { baseId: target.endpoint.baseId, path: target.endpoint.path }
      : target.side.relativePath != null
        ? { baseId: target.side.publicBaseId, path: target.side.relativePath }
        : null;
  if (!place) throw new Error(fallback);
  const response = await apiClient.bases[":baseId"].entry.$get(
    { param: { baseId: place.baseId }, query: { path: place.path } },
    { init: { signal } },
  );
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

/** A folder opens as its listing; a file opens in its folder with its detail. */
export const entryHref = ({ base, entry }: Pick<EntryResult, "base" | "entry">) =>
  entry.directory ? filesUrl(base.id, entry.path) : filesUrl(base.id, entry.path.split("/").slice(0, -1).join("/"), null, entry.path);

/* Recovery: each action resolves the entry again on the server, with current rights, identity and journals. */

export async function loadRecovery(entry: ActivityEntry, signal: AbortSignal, fallback: string) {
  const response = await apiClient.activity[":activityId"].recovery.$get({ param: { activityId: entry.id } }, { init: { signal } });
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

/** A name conflict at the old place asks for a new name; every other refusal (403, 409) is shown as it is. */
export async function restoreActivity(entry: ActivityEntry, name: string | undefined, fallback: string): Promise<RestoreOutcome> {
  const response = await apiClient.activity[":activityId"].restore.$post({ param: { activityId: entry.id }, json: name ? { name } : {} });
  if (response.ok) return { status: "restored" };
  const error = ErrorSchema.safeParse(await response.json().catch(() => null));
  if (Number(response.status) === 409 && error.success && error.data.code === "path_conflict") return { status: "name_conflict" };
  throw new Error(error.success ? error.data.message : fallback);
}

export async function moveActivityBack(entry: ActivityEntry, fallback: string) {
  const response = await apiClient.activity[":activityId"]["move-back"].$post({ param: { activityId: entry.id } });
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

export async function recheckActivity(entry: ActivityEntry, fallback: string) {
  const response = await apiClient.activity[":activityId"].recheck.$post({ param: { activityId: entry.id } });
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}

/** The existing in-place version restore; the server checks the file and the version again. */
export async function restoreVersion(baseId: string, file: Pick<FileEntry, "path" | "revision">, versionId: string, fallback: string) {
  const response = await apiClient.bases[":baseId"].versions.restore.$post({
    param: { baseId },
    json: { path: file.path, id: versionId, expectedRevision: file.revision },
  });
  if (!response.ok) return apiFailure(response, fallback);
  return response.json();
}
