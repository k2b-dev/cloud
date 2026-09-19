import type { RequestActor } from "@k2b/cloud/server";
import { FilegateError, type Node, type RootClient, type TransferResult } from "@k2b/filegate";
import { z } from "zod";
import type { BaseSummary, EntryResult, TrashEntry } from "../contracts";
import { withRootLock } from "../data/operations";
import { type TrashRow, trash } from "../data/trash";
import { operationError, runFileBatch } from "./batches";
import { FilesError } from "./errors";
import { joinPath, relativePath, userPath } from "./paths";

/** Request-authorized location. Rights checks remain in the owning service. */
export type TrashLocation = {
  root: Pick<RootClient, "stat" | "transfer" | "list">;
  rootName: string;
  serverUrl: string;
  basePath: string;
  bindingId: string;
  userId: string;
  base: BaseSummary;
  relative: string;
  node: Node;
  check: (absolutePath: string, rights: number) => Promise<void>;
  ensureTrash: () => Promise<void>;
  forget: (relative: string) => Promise<void>;
};
export type TrashAuthority = (
  actor: RequestActor,
  baseId: string,
  path: string,
  access: "read" | "move" | "write-parent",
) => Promise<TrashLocation>;
const PAGE_SIZE = 50;
const Cursor = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("records"), date: z.string().datetime(), id: z.string().uuid() }),
  z.object({ phase: z.literal("filesystem"), after: z.string().max(8192).optional() }),
]);
const encode = (value: z.infer<typeof Cursor>) => Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value?: string): z.infer<typeof Cursor> | undefined {
  if (!value) return undefined;
  if (value.length > 16384) throw new FilesError("invalid_cursor");
  try {
    return Cursor.parse(JSON.parse(Buffer.from(value, "base64url").toString()));
  } catch {
    throw new FilesError("invalid_cursor");
  }
}
async function stat(root: Pick<RootClient, "stat">, path: string): Promise<Node | null> {
  try {
    return await root.stat(path);
  } catch (error) {
    if (error instanceof FilegateError && error.status === 404) return null;
    throw error;
  }
}
/** Same conservative fingerprint as directory lifecycle; no claim of atomic CAS. */
export const sameTrashNode = (before: Node | null, after: Node) =>
  before !== null &&
  before.directory === after.directory &&
  before.uid === after.uid &&
  before.gid === after.gid &&
  before.mode === after.mode &&
  (before.id ? before.id === after.id : before.modified === after.modified && before.size === after.size);
const recordEntry = (row: TrashRow): TrashEntry => ({
  id: row.id,
  original: row.original,
  name: (row.original ?? row.trashed).split("/").at(-1)!,
  directory: row.directory,
  deletedAt: row.original === null ? null : row.deleted_at.toISOString(),
  state: row.state === "pending" || row.state === "restoring" ? row.state : "trashed",
  ...(row.error_code ? { error: row.error_code } : {}),
});
const fileEntry = (path: string, node: Node) => ({
  name: path.split("/").at(-1)!,
  path,
  directory: node.directory,
  size: node.size,
  modified: node.modified,
});
const filesystemId = (path: string) => `fs:${Buffer.from(path).toString("base64url")}`;
function filesystemPath(id: string): string {
  const path = relativePath(Buffer.from(id.slice(3), "base64url").toString(), false);
  if (!path.startsWith("trash/") || path.split("/").length !== 2 || filesystemId(path) !== id) throw new FilesError("invalid_path");
  return path;
}

export function createTrashLifecycle(authorize: TrashAuthority, store = trash, lock = withRootLock) {
  const sameLocation = (before: TrashLocation, after: TrashLocation) => {
    if (
      before.bindingId !== after.bindingId ||
      before.basePath !== after.basePath ||
      before.rootName !== after.rootName ||
      before.serverUrl !== after.serverUrl
    )
      throw new FilesError("binding_changed", 409);
  };
  async function locked<T>(root: string, run: () => Promise<T>): Promise<T> {
    try {
      return await lock(root, run);
    } catch (error) {
      if (error instanceof Error && error.message === "operation_busy") throw new FilesError("operation_busy", 409);
      throw error;
    }
  }
  async function reconcile(current: TrashLocation, row: TrashRow, execute: boolean): Promise<Node | null> {
    if (row.root !== current.rootName || (row.server_url !== null && row.server_url !== current.serverUrl))
      throw new FilesError("binding_changed", 409);
    const restoring = row.state === "restoring";
    if (row.state !== "pending" && !restoring) return stat(current.root, joinPath(current.basePath, row.trashed));
    if (row.error_code === "transfer_pending") throw new FilesError("transfer_pending", 409);
    const sourcePath = restoring ? row.trashed : row.original;
    const targetPath = restoring ? row.restore_path : row.trashed;
    if (!sourcePath || !targetPath) throw new FilesError("operation_unresolved", 409);
    const sourceAbsolute = joinPath(current.basePath, sourcePath);
    const targetAbsolute = joinPath(current.basePath, targetPath);
    try {
      let source = await stat(current.root, sourceAbsolute);
      let target = await stat(current.root, targetAbsolute);
      if (source && target) throw new FilesError("path_conflict", 409);
      if (!source && !target) throw new FilesError("operation_unresolved", 409);
      if (source) {
        if (!sameTrashNode(row.snapshot, source)) throw new FilesError("source_changed", 409);
        if (!execute) return null;
        await current.check(sourceAbsolute, source.directory ? 5 : 4);
        await current.check(sourceAbsolute.split("/").slice(0, -1).join("/") || ".", 3);
        await current.check(targetAbsolute.split("/").slice(0, -1).join("/") || ".", 3);
        let receipt: TransferResult | undefined;
        let answered = false;
        try {
          receipt = await current.root.transfer(sourceAbsolute, current.rootName, targetAbsolute, { move: true, onConflict: "error" });
          answered = true;
        } catch (error) {
          source = await stat(current.root, sourceAbsolute);
          target = await stat(current.root, targetAbsolute);
          if (source || !target) throw error;
        }
        if (answered) {
          if (receipt?.state !== "completed") throw new FilesError("transfer_pending", 409);
          if (!receipt.node || receipt.node.root !== current.rootName || receipt.node.path !== targetAbsolute)
            throw new FilesError("operation_unresolved", 409);
          target = await stat(current.root, receipt.node.path);
        } else target = await stat(current.root, targetAbsolute);
      }
      if (!target || !sameTrashNode(row.snapshot, target)) throw new FilesError("operation_unresolved", 409);
      await current.check(targetAbsolute, target.directory ? 5 : 4);
      await store.finish(row.id, restoring ? "restored" : "trashed");
      row.state = restoring ? "restored" : "trashed";
      row.error_code = null;
      if (!restoring) await current.forget(row.original!);
      return target;
    } catch (error) {
      await store.error(row.id, operationError(error));
      row.error_code = operationError(error);
      throw error;
    }
  }
  return {
    async remove(actor: RequestActor, input: { baseId: string; paths: string[] }) {
      return runFileBatch(
        input.paths,
        (path) => authorize(actor, input.baseId, path, "move"),
        async (prepared, path) => {
          // Reauthorize after batch preflight, immediately before this entry's effect.
          return locked(prepared.rootName, async () => {
            const source = await authorize(actor, input.baseId, path, "move");
            sameLocation(prepared, source);
            await source.ensureTrash();
            let row = await store.pending(source.bindingId, source.relative);
            if (!row) {
              const id = crypto.randomUUID();
              row = await store.create({
                id,
                base_id: source.bindingId,
                user_id: source.userId,
                root: source.rootName,
                server_url: source.serverUrl,
                original: source.relative,
                trashed: `trash/${id}`,
                directory: source.node.directory,
                snapshot: source.node,
                state: "pending",
              });
            }
            await reconcile(source, row, true);
            return recordEntry(row);
          });
        },
      );
    },
    async trash(
      actor: RequestActor,
      input: { baseId: string; after?: string },
    ): Promise<{ base: BaseSummary; entries: TrashEntry[]; next: string | null }> {
      const current = await authorize(actor, input.baseId, "", "read");
      const cursor = decode(input.after);
      const entries: TrashEntry[] = [];
      if (cursor?.phase !== "filesystem") {
        const rows = await store.list(current.bindingId, cursor?.phase === "records" ? cursor : undefined, PAGE_SIZE + 1);
        if (rows.length === 0) return this.trash(actor, { ...input, after: encode({ phase: "filesystem" }) });
        for (const listed of rows.slice(0, PAGE_SIZE)) {
          let row = listed;
          if (row.root !== current.rootName || (row.server_url !== null && row.server_url !== current.serverUrl)) continue;
          const path = joinPath(current.basePath, row.trashed);
          try {
            // A pending move may still be at its original path. Never disclose it
            // solely because the actor can list the base's trash directory.
            const node = await stat(current.root, path);
            if (node) await current.check(path, node.directory ? 5 : 4);
            else if (row.original || row.restore_path) {
              const original = row.restore_path ?? row.original!;
              // A source can already have moved, or an operator may have removed
              // both locations. Keep the unresolved intent visible to readers of
              // its original parent instead of silently dropping the journal.
              await authorize(actor, input.baseId, original.split("/").slice(0, -1).join("/"), "read");
            } else continue;
            if (row.state === "pending" || row.state === "restoring") {
              await locked(current.rootName, async () => {
                const fresh = await authorize(actor, input.baseId, "", "read");
                sameLocation(current, fresh);
                const latest = await store.get(row.id, fresh.bindingId);
                if (!latest) throw new FilesError("not_found", 404);
                row = latest;
                return reconcile(fresh, row, false);
              }).catch((error) => {
                if (error instanceof FilesError && error.status === 403) throw error;
                // Preserve unresolved journal entries for diagnosis and retry.
              });
            }
            if (row.state !== "restored" && row.state !== "gone") entries.push(recordEntry(row));
          } catch (error) {
            if ((error instanceof FilesError || error instanceof FilegateError) && [403, 404].includes(error.status)) continue;
            throw error;
          }
        }
        const last = rows[Math.min(rows.length, PAGE_SIZE) - 1];
        return {
          base: current.base,
          entries,
          next:
            rows.length > PAGE_SIZE && last
              ? encode({ phase: "records", date: last.cursor_date ?? last.deleted_at.toISOString(), id: last.id })
              : encode({ phase: "filesystem" }),
        };
      }
      const trashPath = joinPath(current.basePath, "trash");
      const directory = await stat(current.root, trashPath);
      if (!directory) return { base: current.base, entries, next: null };
      await current.check(trashPath, 5);
      const page = await current.root.list(trashPath, { after: cursor.after, limit: PAGE_SIZE });
      for (const node of page.items) {
        const path = node.path.slice(current.basePath.length + 1);
        if (await store.at(current.bindingId, path)) continue;
        try {
          await current.check(node.path, node.directory ? 5 : 4);
        } catch (error) {
          if ((error instanceof FilesError || error instanceof FilegateError) && [403, 404].includes(error.status)) continue;
          throw error;
        }
        entries.push({
          id: filesystemId(path),
          original: null,
          name: path.split("/").at(-1)!,
          directory: node.directory,
          deletedAt: null,
          state: "trashed",
        });
      }
      return { base: current.base, entries, next: page.next ? encode({ phase: "filesystem", after: page.next }) : null };
    },
    async restoreTrash(actor: RequestActor, input: { baseId: string; id: string; path?: string }): Promise<EntryResult> {
      const located = await authorize(actor, input.baseId, "", "read");
      return locked(located.rootName, async () => {
        const current = await authorize(actor, input.baseId, "", "read");
        sameLocation(located, current);
        let row = input.id.startsWith("fs:")
          ? await store.at(current.bindingId, filesystemPath(input.id))
          : await store.get(input.id, current.bindingId);
        if (!row && input.id.startsWith("fs:")) {
          const path = filesystemPath(input.id);
          const node = await stat(current.root, joinPath(current.basePath, path));
          // A stable filesystem ID must also recover a lost successful response.
          // A newly created item at the same path receives a fresh journal entry.
          if (!node) row = await store.at(current.bindingId, path, true);
          if (!node && !row) throw new FilesError("not_found", 404);
          if (node) {
            await current.check(joinPath(current.basePath, path), node.directory ? 5 : 4);
            if (!input.path) throw new FilesError("restore_destination_required");
            userPath(input.path);
            await authorize(actor, input.baseId, input.path, "write-parent");
            row = await store.create({
              id: crypto.randomUUID(),
              base_id: current.bindingId,
              user_id: current.userId,
              root: current.rootName,
              server_url: current.serverUrl,
              original: null,
              trashed: path,
              directory: node.directory,
              snapshot: node,
              state: "trashed",
            });
          }
        }
        if (!row || row.state === "gone") throw new FilesError("not_found", 404);
        if (row.root !== current.rootName || (row.server_url !== null && row.server_url !== current.serverUrl))
          throw new FilesError("binding_changed", 409);
        if (row.state === "restored") {
          if (!row.restore_path || !row.snapshot) throw new FilesError("not_found", 404);
          const restored = await authorize(actor, input.baseId, row.restore_path, "read");
          sameLocation(current, restored);
          if (restored.bindingId !== current.bindingId || !sameTrashNode(row.snapshot, restored.node))
            throw new FilesError("source_changed", 409);
          return { base: restored.base, entry: fileEntry(row.restore_path, restored.node) };
        }
        if (row.state === "pending") {
          await reconcile(current, row, false);
          if (row.state === "pending") throw new FilesError("operation_unresolved", 409);
        }
        const path = userPath(row.state === "restoring" ? row.restore_path! : (input.path ?? row.original ?? ""));
        if (!path) throw new FilesError("restore_destination_required");
        const destination = await authorize(actor, input.baseId, path, "write-parent");
        sameLocation(current, destination);
        if (row.state !== "restoring") {
          const node = await current.root.stat(joinPath(current.basePath, row.trashed));
          await current.check(joinPath(current.basePath, row.trashed), node.directory ? 5 : 4);
          if (await stat(current.root, joinPath(current.basePath, path))) throw new FilesError("path_conflict", 409);
          await store.restoring(row.id, path, node, current.serverUrl);
          row = { ...row, state: "restoring", restore_path: path, snapshot: node, server_url: current.serverUrl };
        }
        const restored = await reconcile(current, row, true);
        if (!restored) throw new FilesError("operation_unresolved", 409);
        return { base: destination.base, entry: fileEntry(path, restored) };
      });
    },
  };
}
