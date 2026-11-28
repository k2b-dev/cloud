import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import type { SourceEvent } from "../contracts";
import { type AccessScope, requireBaseAccess } from "./access-control";
import { iso } from "./telemetry-values";

/** Entries the open source's history shows at most, newest first. */
export const SOURCE_HISTORY_MAX = 10;

/**
 * What happened to one source, newest first, from the base's activity log: who created or changed it, and when it
 * stopped delivering or delivered again. One bounded read; the caller's access to the base is checked here.
 */
export const sourceHistory = async (params: { baseId: string; sourceId: string; user: AccessScope }): Promise<Result<SourceEvent[]>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return fail(access.error);
  const [source] = await sql<{ short_id: string }[]>`
    SELECT short_id FROM pulse.sources WHERE id = ${params.sourceId}::uuid AND base_id = ${params.baseId}::uuid AND NOT deleted`;
  if (!source) return fail(err.notFound("Source"));
  const rows = await sql<{ at: Date | string; kind: string; actor: { kind: string; name: string } | null; stale: boolean | null }[]>`
    SELECT at, kind, actor, (data->>'stale')::boolean AS stale
    FROM pulse.base_activity
    WHERE base_id = ${params.baseId}::uuid
      AND kind IN ('source.created', 'source.updated', 'source_freshness')
      AND data->>'sourceId' = ${source.short_id}
    ORDER BY at DESC, id DESC
    LIMIT ${SOURCE_HISTORY_MAX}
  `;
  return ok(
    rows.map((row) => ({
      at: iso(row.at),
      kind: row.kind === "source.created" ? "created" : row.kind === "source.updated" ? "updated" : row.stale ? "stale" : "fresh",
      actor: row.actor ? { kind: row.actor.kind === "service_account" ? "service_account" : "user", name: row.actor.name } : null,
    })),
  );
};
