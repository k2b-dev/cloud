import type { AccessSubject, PermissionLevel, RequestActor, User } from "@k2b/cloud/contracts";
import { err, fail, hasPermission, ok, type Result } from "@k2b/cloud/server";
import { isStandaloneServiceAccountKind } from "@k2b/cloud/services";

const VENUE_APP_ID = "venue";
const VENUE_RESOURCE_TYPE = "venue";

export type VenueAccessScope = {
  user: User | null;
  subject: AccessSubject;
  serviceAccountResourceId: string | null;
  serviceAccountScopes: string[];
};

export const permissionFromVenueScopes = (scopes: string[] | undefined): PermissionLevel => {
  if (scopes?.includes("admin")) return "admin";
  if (scopes?.includes("write")) return "write";
  if (scopes?.includes("read")) return "read";
  return "none";
};

/**
 * Resolves who a request acts as. A user-delegated key acts as its user; a
 * standalone or agent account reads through its own grants and a
 * resource-bound key only through its bound venue. Both are capped by their
 * credential scopes.
 */
export const venueAccessScopeFor = (actor: RequestActor, subject: AccessSubject): Result<VenueAccessScope> => {
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (actor.kind !== "service_account" || actor.serviceAccount.kind === "user_delegated") {
    return ok({ user, subject, serviceAccountResourceId: null, serviceAccountScopes: [] });
  }

  if (isStandaloneServiceAccountKind(actor.serviceAccount.kind)) {
    if (
      subject.type !== "service_account" ||
      subject.serviceAccountId !== actor.serviceAccount.id ||
      !hasPermission(permissionFromVenueScopes(actor.scopes), "read")
    ) {
      return fail(err.forbidden("Access denied"));
    }
    return ok({ user: null, subject, serviceAccountResourceId: null, serviceAccountScopes: actor.scopes });
  }

  const resourceId = actor.serviceAccount.resourceId;
  if (
    actor.serviceAccount.appId !== VENUE_APP_ID ||
    actor.serviceAccount.resourceType !== VENUE_RESOURCE_TYPE ||
    !resourceId ||
    !hasPermission(permissionFromVenueScopes(actor.scopes), "read")
  ) {
    return fail(err.forbidden("Access denied"));
  }

  return ok({ user, subject, serviceAccountResourceId: resourceId, serviceAccountScopes: actor.scopes });
};
