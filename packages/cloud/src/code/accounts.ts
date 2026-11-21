import type { TransactionSQL } from "bun";
import { type CloudResourceRef, CloudResourceRefSchema, cloudResourceRefAppId } from "../contracts/capabilities";
import { appEventBinding } from "../events/app-events";
import { connections } from "../runtime/connections";

/** Write the owner's title in the transaction that renames it. No Code means a harmless no-op.
 * Only this application's declared Code owners are accepted; UUID grants are unchanged.
 */
export async function codeOwnerTitleChanged(tx: TransactionSQL, ref: CloudResourceRef, title: string): Promise<void> {
  const owner = CloudResourceRefSchema.parse(ref);
  const appId = connections().appId;
  const binding = appEventBinding(appId);
  if (cloudResourceRefAppId(owner) !== appId || !binding.compiled.manifest.code?.owners.includes(owner.type.slice(appId.length + 1)))
    throw new Error("Code owner must belong to this application's declared code.owners");
  await tx`UPDATE auth.service_accounts SET title=${title}
    WHERE kind='code' AND name=${`code:${owner.type}:${owner.id}`} AND title IS DISTINCT FROM ${title}`;
}
