// Types only: the shell evaluates this on every page and must not load the account schemas.
import type { AppRegistryNav } from "../contracts/registry";
import type { Role, User } from "../contracts/shared";

/** An app's declared roles: absent roles admit everyone, and `guest` matches the guest profile. */
export const hasAnyAppRole = (user: User | undefined, roles: readonly Role[] | undefined): boolean =>
  !roles || (!!user && roles.some((role) => (role === "guest" ? user.profile === "guest" : user.roles.includes(role))));

/**
 * Who may see an app's Help and Skills: its navigation roles, or administrators for an app reached only through the
 * admin area (`adminHref` without its own `href`). `undefined` admits every signed-in user.
 */
export const appAudienceRoles = (nav: AppRegistryNav | undefined): readonly Role[] | undefined =>
  nav?.requiresRoles ?? (nav && !nav.href && nav.adminHref ? ["admin"] : undefined);
