import { hasPermission, type PermissionLevel } from "@k2b/cloud/server";
import { serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { MachineRights } from "./machine-contracts";
import { ArtifactError, type ArtifactIdentity } from "./service";

/** Current authority, never the account creator or a cached authentication snapshot. */
export async function machineIdentity(identity: ArtifactIdentity, id: string, required: PermissionLevel = "read") {
  const actor = identity.actor;
  if (
    !actor ||
    actor.kind !== "service_account" ||
    actor.delegatedUser !== null ||
    identity.accessSubject.type !== "service_account" ||
    identity.accessSubject.serviceAccountId !== actor.serviceAccount.id
  )
    throw new ArtifactError("ACCESS_DENIED");
  if (!actor.credentialId) {
    // OAuth credentials carry no API-key row. Require the public request
    // revalidation boundary; a missing continuation fails closed.
    if (
      !identity.machineCredential ||
      !(await identity.machineCredential.isCurrent()) ||
      !actor.credentialExpiresAt ||
      Date.parse(actor.credentialExpiresAt) <= Date.now()
    )
      throw new ArtifactError("ACCESS_DENIED");
    const account = await serviceAccounts.get({ id: actor.serviceAccount.id });
    if (
      !account ||
      account.status !== "active" ||
      account.kind === "user_delegated" ||
      (account.kind === "resource_bound" &&
        (account.appId !== "assistant" || account.resourceType !== "artifact" || account.resourceId !== id))
    )
      throw new ArtifactError("ACCESS_DENIED");
    const cap = actor.scopes.includes("admin")
      ? "admin"
      : actor.scopes.includes("write")
        ? "write"
        : actor.scopes.includes("read")
          ? "read"
          : "none";
    if (!hasPermission(cap, required)) throw new ArtifactError("ACCESS_DENIED");
    return { serviceAccountId: account.id, serviceAccount: account, id: identity.machineCredential.reference, scopes: actor.scopes };
  }
  const current = await serviceAccountCredentials.getOverview({ id: actor.credentialId });
  if (
    !current ||
    current.serviceAccountId !== actor.serviceAccount.id ||
    current.status !== "active" ||
    current.serviceAccount.status !== "active" ||
    current.serviceAccount.kind === "user_delegated" ||
    (current.expiresAt !== null && Date.parse(current.expiresAt) <= Date.now())
  )
    throw new ArtifactError("ACCESS_DENIED");
  const account = current.serviceAccount;
  if (
    account.kind === "resource_bound" &&
    (account.appId !== "assistant" || account.resourceType !== "artifact" || account.resourceId !== id)
  )
    throw new ArtifactError("ACCESS_DENIED");
  const level = (scopes: readonly string[]): PermissionLevel =>
    scopes.includes("admin") ? "admin" : scopes.includes("write") ? "write" : scopes.includes("read") ? "read" : "none";
  if (!hasPermission(level(actor.scopes), required) || !hasPermission(level(current.scopes), required))
    throw new ArtifactError("ACCESS_DENIED");
  return current;
}

/** Effect rights are separate from source access. Direct machine grants only. */
export async function machineRights(db: SQL, artifactId: string, publicId: string, identity: ArtifactIdentity) {
  const current = await machineIdentity(identity, publicId);
  const rows = await db<{ rights: unknown }[]>`SELECT m.rights FROM assistant.artifact_access l
    JOIN auth.access a ON a.id=l.access_id LEFT JOIN assistant.artifact_machine_rights m ON m.access_id=l.access_id
    WHERE l.artifact_id=${artifactId}::uuid AND a.service_account_id=${current.serviceAccountId}::uuid
    AND a.permission IN ('read','write','admin')`;
  // One direct account grant is maintained by the management service. Existing
  // duplicate grants remain fail-closed instead of combining partial authority.
  if (rows.length !== 1) throw new ArtifactError("ACCESS_DENIED");
  return MachineRights.parse(typeof rows[0]!.rights === "string" ? JSON.parse(rows[0]!.rights) : (rows[0]!.rights ?? {}));
}

export async function machineDataRight(
  db: SQL,
  artifactId: string,
  publicId: string,
  identity: ArtifactIdentity,
  kind: "storage" | "database",
  write: boolean,
) {
  if (identity.actor.kind !== "service_account" || identity.actor.delegatedUser !== null) return;
  await machineIdentity(identity, publicId, write ? "write" : "read");
  const rights = await machineRights(db, artifactId, publicId, identity);
  if (!hasPermission(rights[kind], write ? "write" : "read")) throw new ArtifactError("ACCESS_DENIED");
}
