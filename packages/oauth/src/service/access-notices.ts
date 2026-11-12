import { sql } from "@k2b/cloud";
import { sendOAuthNewAccessNotice } from "./token-authority";

/** Retry a bounded page after commit, including families revoked or expired since issuance. */
export const notifyPendingOAuthNewAccess = async ({
  notify = sendOAuthNewAccessNotice,
  signal,
  familyId,
}: {
  notify?: typeof sendOAuthNewAccessNotice;
  signal?: AbortSignal;
  familyId?: string;
} = {}): Promise<void> => {
  if (signal?.aborted) return;
  const rows = await sql<{ id: string; user_id: string; client_id: string; client_name: string; created_at: Date }[]>`
    SELECT f.id,f.user_id,f.client_id,c.name AS client_name,f.created_at
    FROM oauth.refresh_token_families f JOIN oauth.clients c ON c.client_id=f.client_id
    WHERE f.notified_at IS NULL AND f.status <> 'reserved' AND (${familyId ?? null}::uuid IS NULL OR f.id=${familyId ?? null}::uuid) ORDER BY f.created_at,f.id LIMIT 100`;
  const failures: unknown[] = [];
  for (const row of rows) {
    if (signal?.aborted) return;
    try {
      await notify({
        familyId: row.id,
        userId: row.user_id,
        clientId: row.client_id,
        clientName: row.client_name,
        createdAt: row.created_at.toISOString(),
      });
      await sql`UPDATE oauth.refresh_token_families SET notified_at=now() WHERE id=${row.id}::uuid AND notified_at IS NULL`;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new Error("OAuth new-access notices remain pending", { cause: failures[0] });
};
