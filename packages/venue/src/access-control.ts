import type { AccessSubject, PermissionLevel, RequestActor, User } from "@k2b/cloud/contracts";
import { err, fail, hasPermission, ok, type Result } from "@k2b/cloud/server";

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

export const venueAccessScopeFor = (actor: RequestActor, subject: AccessSubject): Result<VenueAccessScope> => {
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (actor.kind !== "service_account" || actor.serviceAccount.kind !== "resource_bound") {
    return ok({ user, subject, serviceAccountResourceId: null, serviceAccountScopes: [] });
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
