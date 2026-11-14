import { appEvents } from "@k2b/cloud/events";
import type { Node } from "@k2b/filegate";
import type { TransactionSQL } from "bun";
import { z } from "zod";
import type { filesCapabilities } from "./capabilities";
import type { BaseSummary } from "./contracts";
import { entryRef, persistedEntryRefId } from "./data/references";
import { fileEntry } from "./service/file-entry";

export const filesEvents = {
  "entry.created": {
    version: 1,
    title: "File uploaded",
    description: "An upload creating a file was committed in a folder.",
    subject: "entry",
    place: "entry",
    schema: z.strictObject({}),
  },
  "entry.replaced": {
    version: 1,
    title: "File replaced by upload",
    description: "An upload replacing an existing file was committed in a folder.",
    subject: "entry",
    place: "entry",
    schema: z.strictObject({}),
  },
} as const;

const UploadEventScopeSchema = z.strictObject({
  baseId: z.string().min(1).max(512),
  place: z.string().min(1).max(512),
  stableIds: z.boolean(),
});
export type UploadEventScope = z.infer<typeof UploadEventScopeSchema>;

/** Bind the authorized parent before issuing a session; retain it with the upload's durable intent. */
export async function uploadEventScope(base: Pick<BaseSummary, "id" | "stableIds">, parent: Node, path: string): Promise<UploadEventScope> {
  const parentPath = path.split("/").slice(0, -1).join("/");
  return UploadEventScopeSchema.parse({
    baseId: base.id,
    // The entry reader resolves stable IDs below the base; its root is addressed by an empty path.
    place: await entryRef(base.id, fileEntry({ ...base, stableIds: parentPath ? base.stableIds : false }, parentPath, parent)),
    stableIds: base.stableIds === true,
  });
}

// Resolve the platform binding lazily; capability handlers import the Files services.
const publisher = appEvents<typeof filesCapabilities>("filesv2");

/** One discrete fact per confirmed upload, atomically with its receipt. No directory or revision fan-out. */
export async function publishUploadEvent(
  tx: TransactionSQL,
  action: "file.upload" | "file.overwrite",
  scope: unknown,
  path: string,
  result: Node,
): Promise<void> {
  // Reservations predating this declaration have no event scope; do not invent historical events on receipt reads.
  if (scope === undefined) return;
  const stored = UploadEventScopeSchema.parse(scope);
  const finalPath = [...path.split("/").slice(0, -1), result.path.split("/").at(-1)!].join("/");
  const entry = fileEntry({ id: stored.baseId, stableIds: stored.stableIds }, finalPath, result);
  const subject = entry.resourceId ?? (await persistedEntryRefId(stored.baseId, finalPath, tx));
  await publisher.publish(tx, action === "file.overwrite" ? "entry.replaced" : "entry.created", {
    subject,
    place: stored.place,
    data: {},
  });
  // The caller owns the transaction; the platform's outbox reconciliation wakes after commit.
}
