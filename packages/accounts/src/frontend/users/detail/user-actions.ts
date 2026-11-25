import type { User } from "@/contracts";

/** The break-glass account created by `ADMIN_LOGIN_TOKEN`; it needs no email and gets no login tokens. */
export const EMERGENCY_ADMIN_UID = "admin";

/**
 * Which deeds the actions menu offers for this account. The server decides again for each; this only keeps deeds that
 * cannot work out of the menu.
 */
export const userActionAvailability = (user: User, freeIpaEnabled: boolean) => {
  const ipa = user.provider === "ipa";
  const local = user.provider === "local";
  const canMutate = !ipa || freeIpaEnabled;
  return {
    canMutate,
    guest: user.profile === "guest",
    localAdmin: local && user.roles.includes("admin"),
    /** Profile and admin role are changed here only for local accounts; FreeIPA derives them. */
    local,
    /** Back to a local account and a new password: only while FreeIPA can be reached. */
    ipaDeeds: ipa && freeIpaEnabled,
    createIpa: freeIpaEnabled && local && Boolean(user.mail),
    // Login tokens are bound to the account, so they also work without an email address.
    // Administrators get none for the emergency account; it uses ADMIN_LOGIN_TOKEN.
    loginToken: local && user.uid !== EMERGENCY_ADMIN_UID,
    notify: Boolean(user.mail),
    setExpiry: canMutate,
    auditByUserHref: `/app/accounts/audit?actor=${encodeURIComponent(user.id)}`,
    auditOnUserHref: `/app/accounts/audit?target=${encodeURIComponent(user.id)}`,
  };
};

/** The email rules of the edit form, as the server applies them. */
export const emailRules = (user: User, localEmailOptional: boolean) => {
  const removable =
    (user.provider === "local" && user.uid === EMERGENCY_ADMIN_UID) ||
    (user.provider === "local" && user.profile === "user" && localEmailOptional);
  return { removable, required: Boolean(user.mail) && !removable };
};
