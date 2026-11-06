import type { AccessSubject, RequestActor } from "../server";
import { hasPermission, type PermissionLevel } from "../server/services/access";

/** Resource operations retain the actor's credential alongside the grant subject. */
export type AiResourceContext = { actor: RequestActor; accessSubject: AccessSubject };

export const aiResourceAccessSubject = (subject: AiResourceContext | null): AccessSubject | null => subject?.accessSubject ?? null;

/** Projects and Skills have no supported resource-bound credential contract. */
export const aiResourcePermissionCap = (subject: AiResourceContext | null): PermissionLevel => {
  if (!subject?.actor || !subject.accessSubject) return "none";
  const { actor, accessSubject } = subject;
  if (actor.kind === "user") {
    return accessSubject.type === "user" && accessSubject.userId === actor.user.id ? "admin" : "none";
  }
  if (actor.serviceAccount.kind === "resource_bound") return "none";
  if (actor.delegatedUser) {
    return actor.serviceAccount.kind === "user_delegated" &&
      accessSubject.type === "user" &&
      accessSubject.userId === actor.delegatedUser.id
      ? "admin"
      : "none";
  }
  if (
    (actor.serviceAccount.kind !== "standalone" && actor.serviceAccount.kind !== "agent") ||
    accessSubject.type !== "service_account" ||
    accessSubject.serviceAccountId !== actor.serviceAccount.id
  )
    return "none";
  return actor.scopes.includes("admin")
    ? "admin"
    : actor.scopes.includes("write")
      ? "write"
      : actor.scopes.includes("read")
        ? "read"
        : "none";
};

export const capAiResourcePermission = (granted: PermissionLevel, subject: AiResourceContext | null): PermissionLevel => {
  const cap = aiResourcePermissionCap(subject);
  return hasPermission(granted, cap) ? cap : granted;
};

export class AiResourceCredentialError extends Error {
  constructor() {
    super("The credential does not permit creating Projects or Skills.");
    this.name = "AiResourceCredentialError";
  }
}

export const requireAiResourceCreation = (subject: AiResourceContext): void => {
  if (!hasPermission(aiResourcePermissionCap(subject), "write")) throw new AiResourceCredentialError();
};
