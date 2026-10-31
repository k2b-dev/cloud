import type { SQL } from "bun";
import { sql } from "../../runtime/clients";
import { isAppSessionActor, userFromActor } from "../../server/actor";
import type { RequestActor, RequestAuthority } from "../../server/middleware/auth";
import { get as getUser, hasInstallationAdminInTransaction } from "../accounts/users";

/** Role reads carry their credential authority, or come from the already verified Cloud Login device protocol. */
export type ApprovalRoleContext = { kind: "request"; authority: RequestAuthority } | { kind: "cloud_login" };

/** Keep credential ceilings when a personal CLI key or administrative OAuth credential acts for a Cloud admin. */
export const approvalAdminActor = (userId: string, authority: RequestAuthority): RequestActor | null => {
  const { actor, scopes } = authority;
  const user = userFromActor(actor);
  if (!user || user.id !== userId || isAppSessionActor(actor) || scopes.includes("ai:inference")) return null;
  if (authority.credentialKind === "invocation" || actor.delegation) return null;
  const credential = authority.credentialKind;
  if (
    actor.kind === "service_account" &&
    (actor.serviceAccount.kind !== "user_delegated" ||
      actor.serviceAccount.status !== "active" ||
      (actor.credentialExpiresAt && new Date(actor.credentialExpiresAt).getTime() <= Date.now()))
  )
    return null;
  const personalKey = credential === "api_key" && actor.kind === "service_account" && scopes.length === 0;
  if (credential !== "session" && !personalKey && !scopes.includes("admin")) return null;
  return actor.kind === "user" ? actor : { kind: "user", user };
};

/** Revalidate category, expiry, roles and FreeIPA projection under the owning transaction's locks. */
export const hasApprovalRoleAccess = async (userId: string, context: ApprovalRoleContext | undefined, db: SQL = sql): Promise<boolean> => {
  if (!context) return false;
  const actor =
    context.kind === "request"
      ? approvalAdminActor(userId, context.authority)
      : await getUser({ id: userId }, { db }).then((user) => (user ? { kind: "user" as const, user } : null));
  return actor !== null && hasInstallationAdminInTransaction(actor, db);
};
