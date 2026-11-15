import { sql } from "@k2b/cloud";
import { listApprovalAdminRecipients } from "@k2b/cloud/services/approvals";
import { machineOwner } from "./machine-access";

/** These readers are installation administration surfaces, rather than storage path grants. */
export async function listFilesManagers(input: { id: string; afterId?: string; userId?: string; limit: number }, type: "storage" | "template") {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) return [];
  const exists = type === "storage" ? await machineOwner(input.id)
    : (await sql`SELECT id FROM filesv2.templates WHERE id=${input.id}::uuid`)[0];
  if (!exists) return [];
  return listApprovalAdminRecipients(sql, { after: input.afterId, userId: input.userId, limit: input.limit });
}
