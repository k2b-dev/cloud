import type { RequestAuthority } from "../../server/middleware/auth";
import type { CloudInvocationClaims, InvocationAuthority } from "./invocation-token";

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
      ...(authority.credentialKind === "session" && authority.actor.sessionKind === "app" ? { session_kind: "app" as const } : {}),
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

/** A principal or delegation change cannot turn an existing invocation into new authority. */
export const matchesInvocationSubject = (parent: CloudInvocationClaims, current: RequestAuthority): boolean => {
  const actor = current.actor;
  const subject = current.accessSubject;
  return (
    (actor.kind === "user" ? actor.user.id : actor.serviceAccount.id) === parent.sub &&
    actor.kind === parent.principal_type &&
    subject.type === parent.access_subject_type &&
    (subject.type === "user" ? subject.userId : subject.serviceAccountId) === parent.access_subject_id
  );
};

/** Copy only authority fields, preserving every ceiling. Never relabel an invocation as a session. */
export const authorityFromParentInvocation = (parent: CloudInvocationClaims): InvocationAuthority => ({
  sub: parent.sub,
  principal_type: parent.principal_type,
  access_subject_type: parent.access_subject_type,
  access_subject_id: parent.access_subject_id,
  ...(parent.delegated_user_id ? { delegated_user_id: parent.delegated_user_id } : {}),
  credential_kind: parent.credential_kind,
  ...(parent.session_kind ? { session_kind: parent.session_kind } : {}),
  ...(parent.credential_id ? { credential_id: parent.credential_id } : {}),
  scopes: [...parent.scopes],
  ...(parent.mandate_id
    ? {
        mandate_id: parent.mandate_id,
        mandate_revision: parent.mandate_revision,
        workload_type: parent.workload_type,
        workload_id: parent.workload_id,
      }
    : {}),
});
