import { sql } from "@k2b/cloud";
import { audit } from "@k2b/cloud/services";
import type { MutationResult } from "@/contracts";
import * as clients from "./clients";
import * as codes from "./codes";
import * as device from "./device";
import * as refreshTokens from "./refresh-tokens";

/**
 * Disconnect one person, or everyone, from a client: their refresh tokens stop working at once, sign-ins still on
 * their way (an unexchanged code, an open or approved device sign-in) end, and the access tokens already issued run
 * out at their short expiry. One audit entry names who did it, the client and whom.
 */
export const revokeConnections = async (params: {
  id: string;
  /** The person to disconnect; null disconnects everyone. */
  userId: string | null;
  actor: clients.OAuthClientAdminActor;
}): Promise<MutationResult<{ revoked: number }>> => {
  const existing = await clients.get({ id: params.id });
  if (!existing) return { ok: false, error: "Client not found", status: 404 };

  return sql.begin(async (tx) => {
    const scope = { db: tx, clientId: existing.clientId, userId: params.userId };
    await codes.expireUnissued(scope);
    await device.expireUnissued(scope);
    const revoked = await refreshTokens.revokeClientFamilies({
      ...scope,
      reason: params.userId ? "admin_disconnect_user" : "admin_disconnect_all",
    });
    await audit.record(
      {
        action: "oauth.client.connections_revoke",
        outcome: "allowed",
        actor: {
          userId: params.actor.id,
          uid: params.actor.uid,
          provider: params.actor.provider,
          roles: params.actor.roles,
        },
        target: { type: "oauth_client", id: existing.id, label: existing.name },
        metadata: { clientId: existing.clientId, userId: params.userId, all: params.userId === null, revoked },
      },
      tx,
    );
    return { ok: true, data: { revoked } } as const;
  });
};
