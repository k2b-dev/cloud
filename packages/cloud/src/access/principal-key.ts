import type { Principal } from "../contracts/shared";

/** One stable key per principal, so a principal appears once in a list. */
export const principalKey = (p: Principal) =>
  p.type === "user"
    ? `u:${p.userId}`
    : p.type === "group"
      ? `g:${p.groupId}`
      : p.type === "service_account"
        ? `s:${p.serviceAccountId}`
        : p.type;
