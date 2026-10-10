import { hasRole, type Role, type User } from "../contracts/shared";

/** An app's declared roles: absent roles admit everyone, and `guest` matches the guest profile. */
export const hasAnyAppRole = (user: User | undefined, roles: readonly Role[] | undefined): boolean =>
  !roles || (!!user && roles.some((role) => (role === "guest" ? user.profile === "guest" : hasRole(user, role))));
