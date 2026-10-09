import type { PermissionLevel, Principal } from "@k2b/cloud/contracts/shared";

type Grant = { principal: Principal; permission: PermissionLevel };

/**
 * The principal a 'none' grant shadows. The manager guard counts a group's grant regardless of its members,
 * so a group deny shadows only that group's own grants, never another group that shares members.
 */
const denyScope = (principal: Principal): string | null => {
  switch (principal.type) {
    case "user":
      return `user:${principal.userId}`;
    case "service_account":
      return `service_account:${principal.serviceAccountId}`;
    case "group":
      return `group:${principal.groupId}`;
    case "authenticated":
      return "authenticated";
    case "public":
      return null;
  }
};

/**
 * Drop the grants a deny for the same principal shadows, so only grants that still apply count as managers.
 * The base manager guard and the base access editors share this rule, so the editor locks exactly the
 * rows whose change the service refuses.
 */
export const unshadowedGrants = <T extends Grant>(entries: readonly T[]): T[] => {
  const denied = new Set(entries.filter((entry) => entry.permission === "none").map((entry) => denyScope(entry.principal)));
  return entries.filter((entry) => !denied.has(denyScope(entry.principal)));
};
