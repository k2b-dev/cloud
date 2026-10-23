import { sql } from "bun";
import type { ServiceAccountRequestActor } from "../../server/middleware/auth";
import { err, fail, ok, type Result } from "../../server/services";
import { audit } from "../audit";
import * as localGroups from "./local-groups";

/** Runs the existing local membership operation while its direct management grant is locked. */
export async function mutateMachineGroupMember(params: {
  actor: ServiceAccountRequestActor;
  id: string;
  userId?: string;
  groupId?: string;
  serviceAccountId?: string;
  operation: "add" | "remove";
  requestId?: string;
}): Promise<Result<void>> {
  const { actor } = params;
  const action = `accounts.group.member.${params.operation}`;
  const target = { type: "group", id: params.id };
  const metadata = {
    actorServiceAccountId: actor.serviceAccount.id,
    credentialId: actor.credentialId ?? null,
    userId: params.userId ?? null,
    groupId: params.groupId ?? null,
    serviceAccountId: params.serviceAccountId ?? null,
  };
  const denied = () => fail(err.forbidden("A current management grant for this group and write scope are required"));
  if (
    actor.delegatedUser ||
    !["standalone", "agent"].includes(actor.serviceAccount.kind) ||
    !actor.scopes.some((scope) => scope === "write" || scope === "admin") ||
    (actor.credentialExpiresAt && Date.parse(actor.credentialExpiresAt) <= Date.now())
  )
    return audit.recordResult({ action, target, metadata, requestId: params.requestId, result: denied() });

  return sql.begin(async (db) => {
    // Account -> credential -> grant: deletion, disable and revoke serialize with this write.
    const [account] = await db`SELECT id FROM auth.service_accounts
      WHERE id = ${actor.serviceAccount.id}::uuid AND status = 'active' AND kind IN ('standalone','agent') FOR SHARE`;
    let allowed = Boolean(account);
    if (allowed && actor.credentialId) {
      const [credential] = await db`SELECT id FROM auth.service_account_credentials
        WHERE id = ${actor.credentialId}::uuid AND service_account_id = ${actor.serviceAccount.id}::uuid
          AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
          AND scopes && ARRAY['write','admin']::text[] FOR SHARE`;
      allowed = Boolean(credential);
    }
    const [grant] = allowed
      ? await db`SELECT gm.group_id FROM auth.group_manager_service_accounts gm
      JOIN auth.groups g ON g.id = gm.group_id
      WHERE gm.group_id = ${params.id}::uuid AND gm.service_account_id = ${actor.serviceAccount.id}::uuid
        AND g.provider = 'local' FOR SHARE OF gm, g`
      : [];
    let result: Result<void> = denied();
    if (grant) {
      if ([params.userId, params.groupId, params.serviceAccountId].filter(Boolean).length !== 1) {
        result = fail(err.badInput("Choose exactly one member"));
      } else {
        const changed = await localGroups[params.operation === "add" ? "addMember" : "removeMember"](
          {
            id: params.id,
            user: params.userId,
            group: params.groupId,
            serviceAccount: params.serviceAccountId,
          },
          db,
        );
        result = changed.ok
          ? ok()
          : fail({ code: changed.status === 403 ? "FORBIDDEN" : "GROUP_MUTATION_FAILED", message: changed.error, status: changed.status });
      }
    }
    await audit.record(
      {
        action,
        target,
        metadata,
        requestId: params.requestId,
        outcome: result.ok ? "allowed" : result.error.status === 403 ? "denied" : "failed",
      },
      db,
    );
    return result;
  });
}
