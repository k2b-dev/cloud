import type { AccessSubject, RequestActor } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/cloud/server";
import { sql } from "bun";
import { accessScopeFor, requireBaseAccess } from "./access-control";

export type OwnedIngestIdentity = { actor: RequestActor; accessSubject: AccessSubject; expectedRevision: number };

/** Called by review and again under each ingest transaction's source lock. */
export const requireOwnedIngestSource = async (baseId: string, sourceId: string, identity: OwnedIngestIdentity, db: typeof sql = sql) => {
  const scope = accessScopeFor(identity.actor, identity.accessSubject);
  if (!scope.ok) return scope;
  const access = await requireBaseAccess(baseId, scope.data, "write", db);
  if (!access.ok) return access;
  const subject = identity.accessSubject;
  const owner = subject.type === "user" ? `user:${subject.userId}` : `service_account:${subject.serviceAccountId}`;
  const [source] = await db<{ revision: number; name: string; enabled: boolean }[]>`
    SELECT revision,name,enabled FROM pulse.sources WHERE id=${sourceId}::uuid AND base_id=${baseId}::uuid
      AND NOT deleted AND kind='http_ingest' AND created_by_subject=${owner}`;
  if (!source) return fail(err.forbidden("ingest.write requires an HTTP ingest source created by the current access subject."));
  if (source.revision !== identity.expectedRevision) return fail(err.conflict("Source changed; read its current revision and retry."));
  if (!source.enabled) return fail(err.conflict("Pulse source is disabled"));
  return ok(source);
};
