import type { RequestAuthority } from "./middleware/auth";

/** Credential ceilings survive inter-app invocation; sessions and API keys retain their own contracts. */
export const hasOAuthScope = (authority: RequestAuthority | undefined, ...required: string[]): boolean => {
  if (!authority) return true;
  const oauth =
    authority.credentialKind === "oauth" ||
    (authority.credentialKind === "invocation" && authority.actor.delegation?.credentialKind === "oauth");
  return !oauth || required.some((scope) => authority.scopes.includes(scope));
};
