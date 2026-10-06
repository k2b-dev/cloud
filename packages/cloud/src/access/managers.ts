import type { PermissionLevel, Principal, ServiceAccountKind } from "../contracts/shared";

/** The fields of an access entry that decide whether it manages its resource. */
export type ManagerCandidate = {
  principal: Principal;
  permission: PermissionLevel;
  serviceAccountKind?: ServiceAccountKind | null;
};

/**
 * Whether an entry keeps its resource manageable: `admin` for a user, a group,
 * all signed-in users, or a standalone or agent service account. Public access
 * never counts, and neither do resource-bound or user-delegated keys: they
 * disappear with their key or their user without passing the resource's rules.
 */
export const isManagerEntry = (entry: ManagerCandidate): boolean => {
  if (entry.permission !== "admin") return false;
  switch (entry.principal.type) {
    case "user":
    case "group":
    case "authenticated":
      return true;
    case "service_account":
      return entry.serviceAccountKind === "standalone" || entry.serviceAccountKind === "agent";
    case "public":
      return false;
  }
};

/** Whether a change from `before` to `after` takes a resource from at least one manager to none. */
export const removesLastManager = (before: readonly ManagerCandidate[], after: readonly ManagerCandidate[]): boolean =>
  before.some(isManagerEntry) && !after.some(isManagerEntry);
