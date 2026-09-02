import type { RequestAuthority } from "../../server/middleware/auth";
import type { InvocationAuthority } from "./invocation-token";

export const invocationAuthorityFromRequest = (authority: RequestAuthority): InvocationAuthority => {
  if (authority.credentialKind === "invocation") {
    throw new Error("A Cloud invocation cannot be exchanged for another invocation");
  }

  if (authority.actor.kind === "user") {
    if (authority.accessSubject.type !== "user" || authority.accessSubject.userId !== authority.actor.user.id) {
      throw new Error("User request authority is inconsistent");
    }
    if (authority.credentialKind === "api_key") throw new Error("An API key must act through a service account");
    return {
      sub: authority.actor.user.id,
      principal_type: "user",
      access_subject_type: "user",
      access_subject_id: authority.actor.user.id,
      credential_kind: authority.credentialKind,
      scopes: [...new Set(authority.scopes)].sort(),
    };
  }

  const actor = authority.actor;
  if (actor.delegatedUser) {
    if (authority.accessSubject.type !== "user" || authority.accessSubject.userId !== actor.delegatedUser.id) {
      throw new Error("Delegated request authority is inconsistent");
    }
    return {
      sub: actor.serviceAccount.id,
      principal_type: "service_account",
      access_subject_type: "user",
      access_subject_id: actor.delegatedUser.id,
      delegated_user_id: actor.delegatedUser.id,
      credential_kind: authority.credentialKind,
      ...(actor.credentialId ? { credential_id: actor.credentialId } : {}),
      scopes: [...new Set(authority.scopes)].sort(),
    };
  }

  if (authority.accessSubject.type !== "service_account" || authority.accessSubject.serviceAccountId !== actor.serviceAccount.id) {
    throw new Error("Service-account request authority is inconsistent");
  }
  return {
    sub: actor.serviceAccount.id,
    principal_type: "service_account",
    access_subject_type: "service_account",
    access_subject_id: actor.serviceAccount.id,
    credential_kind: authority.credentialKind,
    ...(actor.credentialId ? { credential_id: actor.credentialId } : {}),
    scopes: [...new Set(authority.scopes)].sort(),
  };
};
