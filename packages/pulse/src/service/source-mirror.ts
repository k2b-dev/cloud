import { sql } from "bun";
import { PULSE_INTERNAL_INGEST_BATCH_LIMIT } from "../ingest-limits";
import { baseStore } from "../store/base-store";
import { requireBaseActive } from "./access-control";
import { type IngestStore, insertStoreRows } from "./ingest-bulk";

/** Commit changes first. Deleted sources remain pending tombstones until their mirror succeeds. */
export const mirrorPendingSources = async (baseId: string, store: IngestStore = baseStore, sourceId?: string) =>
  sql.begin(async (tx) => {
    const active = await requireBaseActive(baseId, tx);
    if (!active.ok) return;
    const [base] = await tx<{ database_name: string }[]>`SELECT database_name FROM pulse.base_stores WHERE base_id=${baseId}::uuid`;
    if (!base) return;
    // One synchronous insert, bounded by the same row budget as internal telemetry batches.
    const sources = await tx<{ id: string; short_id: string; kind: string; name: string; deleted: boolean; version: string }[]>`
    SELECT id,short_id,kind,name,deleted,floor(extract(epoch FROM updated_at)*1000000)::text AS version FROM pulse.sources
    WHERE base_id=${baseId}::uuid AND mirror_pending AND (${sourceId ?? null}::uuid IS NULL OR id=${sourceId ?? null}::uuid)
    ORDER BY updated_at,id LIMIT ${PULSE_INTERNAL_INGEST_BATCH_LIMIT} FOR UPDATE`;
    if (!sources.length) return;
    await insertStoreRows(
      store,
      base.database_name,
      "_sources",
      sources.map((source) => ({
        id: source.id,
        short_id: source.short_id,
        kind: source.kind,
        name: source.name,
        deleted: source.deleted ? 1 : 0,
        version: source.version,
      })),
    );
    const ids = sources.map((s) => s.id);
    await tx`DELETE FROM pulse.sources WHERE id=ANY(${sql.array(ids, "UUID")}) AND deleted`;
    await tx`UPDATE pulse.sources SET mirror_pending=false WHERE id=ANY(${sql.array(ids, "UUID")}) AND NOT deleted`;
  });
export const tryMirrorSource = async (baseId: string, sourceId: string) => {
  try {
    await mirrorPendingSources(baseId, baseStore, sourceId);
  } catch {
    /* The committed mirror_pending row is retried by the usage job. */
  }
};
