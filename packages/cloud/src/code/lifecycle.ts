import type { TransactionSQL } from "bun";
import { capabilityValueDigest } from "../capabilities/calls";
import { type CloudResourceRef, CloudResourceRefSchema, cloudResourceRefAppId } from "../contracts/capabilities";
import { appEventBinding } from "../events/app-events";
import { connections } from "../runtime/connections";

/**
 * Report a deleted Code owner in the transaction deleting the resource. Call
 * this for every owner deleted indirectly, too. A rollback reports nothing;
 * after commit the platform delivers the report to Core at least once. Core
 * locks the Code, revokes its mandates, then durably removes all of its grants
 * before deleting it. Do not call this when an application merely goes offline.
 * The ref must name one of this application's declared code.owners.
 */
export async function codeOwnerDeleted(tx: TransactionSQL, ref: CloudResourceRef): Promise<void> {
  const owner = CloudResourceRefSchema.parse(ref);
  const appId = connections().appId;
  const binding = appEventBinding(appId);
  if (cloudResourceRefAppId(owner) !== appId || !binding.compiled.manifest.code?.owners.includes(owner.type.slice(appId.length + 1)))
    throw new Error("Code owner must belong to this application's declared code.owners");
  const reportId = crypto.randomUUID();
  await tx`SELECT events.enqueue(${reportId}::uuid, ${appId},
    'code_owner_deleted', ${capabilityValueDigest(owner)}, ${JSON.stringify(owner)}::text::jsonb)`;
  await tx`UPDATE events.outbox SET created_at=clock_timestamp() WHERE id=${reportId}::uuid`;
}
