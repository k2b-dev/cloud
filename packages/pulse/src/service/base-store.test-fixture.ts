import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";

/** Existing Postgres measurement suites exercise an already provisioned base, without doing ClickHouse DDL. */
export const seedActiveBaseStore = async (...ids: string[]) => {
  await sql`INSERT INTO pulse.base_stores(base_id,state,operation,database_name,read_user,schema_version,values_per_minute,bytes_per_minute,storage_bytes,max_series,max_event_kinds,max_state_keys)
    SELECT id,CASE WHEN deletion_started_at IS NOT NULL THEN 'deleting' WHEN data_clear_started_at IS NOT NULL AND data_clear_completed_at IS NULL THEN 'clearing' ELSE 'active' END,
      CASE WHEN deletion_started_at IS NOT NULL THEN 'delete' WHEN data_clear_started_at IS NOT NULL AND data_clear_completed_at IS NULL THEN 'clear' ELSE NULL END,
      'pulse_'||replace(id::text,'-',''),'pulse_r_'||replace(id::text,'-',''),1,2000,5242880,5000000000,50000,2000,2000
    FROM pulse.bases WHERE id=ANY(${toPgUuidArray(ids)}::uuid[]) ON CONFLICT(base_id) DO NOTHING`;
};
