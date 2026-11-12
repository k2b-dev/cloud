import type { SQL } from "bun";
import { z } from "zod";
import { connections } from "../runtime/connections";

const ClientSchema = z
  .object({
    clientId: z.string().min(1).max(256),
    serviceAccountId: z.string().uuid().nullable(),
    status: z.enum(["active", "disabled"]),
    name: z.string().min(1).max(120),
  })
  .strict();
export type OAuthClientRegistration = z.infer<typeof ClientSchema>;

/** Maintain verifier facts in the same transaction as the issuer's private client. */
export const oauthClients = {
  async upsert(tx: SQL, input: OAuthClientRegistration): Promise<void> {
    const client = ClientSchema.parse(input);
    const appId = connections().appId;
    const rows = await tx`INSERT INTO auth.oauth_clients (client_id, issuer_app_id, service_account_id, status, name)
      VALUES (${client.clientId}, ${appId}, ${client.serviceAccountId}::uuid, ${client.status}, ${client.name})
      ON CONFLICT (client_id) DO UPDATE SET service_account_id = EXCLUDED.service_account_id,
        status = EXCLUDED.status, name = EXCLUDED.name
      WHERE auth.oauth_clients.issuer_app_id = EXCLUDED.issuer_app_id AND auth.oauth_clients.status <> 'deleted'
      RETURNING client_id`;
    if (rows.length !== 1) throw new Error("OAuth client ID belongs to another issuer or has been deleted");
  },
  async remove(tx: SQL, clientId: string): Promise<void> {
    await tx`UPDATE auth.oauth_clients SET status='deleted'
      WHERE client_id = ${ClientSchema.shape.clientId.parse(clientId)} AND issuer_app_id = ${connections().appId}
        AND status <> 'deleted'`;
  },
};
