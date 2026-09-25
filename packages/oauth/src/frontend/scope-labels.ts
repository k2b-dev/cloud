import type { oauthMessages } from "./messages";

type Messages = ReturnType<typeof oauthMessages.resolve>["t"];

/** Human description of one requested scope, shared by every consent surface. */
export const consentScopeLabel = (scope: string, t: Messages): string => {
  if (scope === "read") return t.scopeConsentRead;
  if (scope === "write") return t.scopeConsentWrite;
  if (scope === "offline_access") return t.scopeConsentOffline;
  if (scope === "openid") return t.scopeConsentOpenId;
  if (scope === "profile") return t.scopeConsentProfile;
  if (scope === "email") return t.scopeConsentEmail;
  if (scope === "groups") return t.scopeConsentGroups;
  if (scope === "admin") return t.scopeConsentAdmin;
  return scope;
};
