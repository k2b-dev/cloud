import type { AccessSubject, AuthContext, RequestCredentialKind } from "@k2b/cloud/server";

export type ArtifactIdentity = {
  credentialKind?: RequestCredentialKind;
  client?: string | null;
  actor: AuthContext["Variables"]["actor"];
  accessSubject: AccessSubject;
  machineExecution?: { version: number };
  machineCredential?: { reference: string; isCurrent: () => Promise<boolean> };
  conversationId?: string;
  administrative?: boolean;
};
export class ArtifactError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "ACCESS_DENIED"
      | "CONFLICT"
      | "STORAGE_FULL"
      | "INVALID_INPUT"
      | "LAST_MANAGER"
      | "TOO_MANY_REQUESTS"
      | "PUBLIC_READ_ONLY"
      | "PUBLIC_SHARING_OFF",
  ) {
    super(code);
  }
}
