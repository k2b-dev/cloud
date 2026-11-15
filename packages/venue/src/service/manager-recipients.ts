import { sql } from "@k2b/cloud";
import { listAccessRecipientUserIds } from "@k2b/cloud/server";

export async function listVenueManagers(input: { id: string; afterId?: string; userId?: string; limit: number }) {
  const rows = await sql<{ access_id: string }[]>`SELECT va.access_id FROM venue.venues v
    JOIN venue.venue_access va ON va.venue_id=v.id WHERE v.short_id=${input.id}`;
  return listAccessRecipientUserIds({ accessIds: rows.map((row) => row.access_id),
    afterId: input.afterId, userId: input.userId, limit: input.limit });
}
