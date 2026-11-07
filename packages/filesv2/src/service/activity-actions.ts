import type { ActivityChain, ActivityEntry } from "../activity-contracts";
import type { EntryResult, TrashEntry } from "../contracts";
import type { RecoveryRecord } from "../data/activity-recovery";
import type { Binding } from "../data/bases";
import type { ActivityReadCall } from "./activity-reader";
import { FilesError } from "./errors";
import { userPath } from "./paths";

/** Recovery uses current checks; a readable historical snapshot alone never authorizes a write. */
export type ActivityRecovery = {
  oldLocation: { baseId: string; path: string } | null;
  trash: { baseId: string; id: string; canRestore: boolean } | null;
  canMoveBack: boolean;
};

type Endpoint = NonNullable<ActivityChain["endpoint"]>;
export type ActivityActionDeps = {
  entry(call: ActivityReadCall, input: { activityId: string }): Promise<ActivityEntry>;
  chain(call: ActivityReadCall, input: { activityId: string }): Promise<ActivityChain>;
  record(id: string): Promise<RecoveryRecord | null>;
  binding(id: string): Promise<Binding | null>;
  /** Must check current membership, binding/server identity and parent read access without provisioning. */
  oldLocation(call: ActivityReadCall, record: RecoveryRecord, binding: Binding, path: string): Promise<void>;
  writable(call: ActivityReadCall, baseId: string, path: string): Promise<void>;
  trashEntry(call: ActivityReadCall, input: { baseId: string; id: string }): Promise<TrashEntry>;
  restoreTrash(call: ActivityReadCall, input: { baseId: string; id: string; path: string }): Promise<EntryResult>;
  /** Must resolve and check the expected stable ID again inside the existing publication lock. */
  moveBack(call: ActivityReadCall, record: RecoveryRecord, endpoint: Endpoint, path: string): Promise<EntryResult>;
  recheck(call: ActivityReadCall, id: string): Promise<void>;
};
const unavailable = (error: unknown) => error instanceof FilesError && [403, 404, 409].includes(error.status);
const publicBaseId = (binding: Binding) => `${binding.area}:${binding.kind}:${binding.identity_id}`;
const parent = (path: string) => path.split("/").slice(0, -1).join("/");

export function createActivityActions(deps: ActivityActionDeps) {
  async function locate(call: ActivityReadCall, activityId: string) {
    await deps.entry(call, { activityId });
    const record = await deps.record(activityId);
    if (!record) throw new FilesError("not_found", 404);
    const binding = record.base_id ? await deps.binding(record.base_id) : null;
    const path = record.path_before;
    if (!binding || binding.lifecycle !== "active" || binding.root !== record.root || !path?.startsWith(`${binding.path}/`))
      return { record, place: null };
    const relative = userPath(path.slice(binding.path.length + 1));
    try {
      await deps.oldLocation(call, record, binding, parent(relative));
      return { record, place: { baseId: publicBaseId(binding), path: relative } };
    } catch (error) {
      if (!unavailable(error)) throw error;
      return { record, place: null };
    }
  }
  async function recovery(call: ActivityReadCall, input: { activityId: string }): Promise<ActivityRecovery> {
    const { record, place } = await locate(call, input.activityId);
    const result: ActivityRecovery = {
      oldLocation: place ? { ...place, path: parent(place.path) } : null,
      trash: null,
      canMoveBack: false,
    };
    if (!place || record.state !== "done") return result;
    if (record.action === "item.trash" && record.trash_id) {
      try {
        const entry = await deps.trashEntry(call, { baseId: place.baseId, id: record.trash_id });
        result.trash = { baseId: place.baseId, id: record.trash_id, canRestore: false };
        if (entry.state === "trashed") {
          await deps.writable(call, place.baseId, place.path);
          result.trash.canRestore = true;
        }
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    if (record.action === "item.move" || record.action === "item.rename") {
      try {
        const chain = await deps.chain(call, input);
        if (
          chain.certainty === "verified" &&
          chain.endpoint?.itemId &&
          chain.endpoint.baseId === place.baseId &&
          chain.endpoint.path !== place.path
        ) {
          await deps.writable(call, place.baseId, place.path);
          // The mutation rechecks source identity and source-parent write permission under its publication lock.
          result.canMoveBack = true;
        }
      } catch (error) {
        if (!unavailable(error)) throw error;
      }
    }
    return result;
  }
  return {
    recovery,
    async restore(call: ActivityReadCall, input: { activityId: string; name?: string }): Promise<EntryResult> {
      const { record, place } = await locate(call, input.activityId);
      if (record.action !== "item.trash" || record.state !== "done" || !record.trash_id || !place) throw new FilesError("not_found", 404);
      const name = input.name;
      if (name !== undefined && (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".."))
        throw new FilesError("invalid_path", 400);
      const path = name === undefined ? place.path : userPath([parent(place.path), name].filter(Boolean).join("/"));
      return deps.restoreTrash(call, { baseId: place.baseId, id: record.trash_id, path });
    },
    async moveBack(call: ActivityReadCall, input: { activityId: string }): Promise<EntryResult> {
      const { record, place } = await locate(call, input.activityId);
      if (!place || record.state !== "done" || !["item.move", "item.rename"].includes(record.action))
        throw new FilesError("not_found", 404);
      const chain = await deps.chain(call, input);
      if (chain.certainty !== "verified" || !chain.endpoint?.itemId || chain.endpoint.baseId !== place.baseId)
        throw new FilesError("source_changed", 409);
      return deps.moveBack(call, record, chain.endpoint, place.path);
    },
    async recheck(call: ActivityReadCall, input: { activityId: string }): Promise<ActivityEntry> {
      const entry = await deps.entry(call, input);
      if (entry.state === "pending" || entry.state === "unclear") await deps.recheck(call, input.activityId);
      return deps.entry(call, input);
    },
  };
}
