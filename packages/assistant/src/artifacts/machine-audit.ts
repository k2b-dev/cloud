import { audit } from "@k2b/cloud/services";
import type { SQL } from "bun";
import type { ArtifactIdentity } from "./service";

/** Only stable identities and outcomes: no source, inputs, logs, URLs, or secret values. */
export async function machineAudit(
  identity: ArtifactIdentity,
  context: { id: string; requestId: string; version: number | null },
  operation: string,
  outcome: "allowed" | "denied" | "failed",
  code?: string,
  db?: SQL,
) {
  const actor = identity.actor;
  if (actor.kind !== "service_account") return;
  await audit.record(
    {
      action: `studio.machine.${operation}`,
      outcome,
      target: { type: "assistant.artifact", id: context.id },
      requestId: context.requestId,
      error: code ? { code } : undefined,
      metadata: {
        serviceAccountId: actor.serviceAccount.id,
        credentialId: actor.credentialId ?? identity.machineCredential?.reference ?? null,
        credentialKind: identity.credentialKind ?? null,
        version: context.version,
      },
    },
    db,
  );
}
