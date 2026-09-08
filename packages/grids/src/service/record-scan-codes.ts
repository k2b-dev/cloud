import { crypto, err } from "@k2b/stdlib";
import { isUniqueViolation } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";

type DbRow = Record<string, unknown>;

type RecordScanCode = {
  id: string;
  baseId: string;
  tableId: string;
  recordId: string;
  code: string;
  active: boolean;
  createdAt: string;
  rotatedAt: string | null;
};

const mapScanCodeRow = (row: DbRow): RecordScanCode => ({
  id: row.id as string,
  baseId: row.base_id as string,
  tableId: row.table_id as string,
  recordId: row.record_id as string,
  code: row.code as string,
  active: row.active as boolean,
  createdAt: (row.created_at as Date).toISOString(),
  rotatedAt: row.rotated_at ? (row.rotated_at as Date).toISOString() : null,
});

const getOrCreateRecordScanCode = async (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  code: string;
  client?: SqlClient;
  locale?: string;
}): Promise<RecordScanCode> => {
  const client = params.client ?? sql;
  const [row] = await client<DbRow[]>`
    INSERT INTO grids.record_scan_codes (base_id, table_id, record_id, code)
    SELECT t.base_id, r.table_id, r.id, ${params.code}
    FROM grids.records r
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE b.id = ${params.baseId}::uuid
      AND t.id = ${params.tableId}::uuid
      AND r.id = ${params.recordId}::uuid
      AND r.deleted_at IS NULL
    ON CONFLICT (record_id) WHERE active = TRUE
    DO UPDATE SET record_id = EXCLUDED.record_id
    RETURNING id, base_id, table_id, record_id, code, active, created_at, rotated_at
  `;
  if (!row) throw err.notFound(getGridsCrudMessages(params.locale).record);
  return mapScanCodeRow(row);
};

export const ensureRecordScanCode = async (params: {
  baseId: string;
  tableId: string;
  recordId: string;
  client?: SqlClient;
  locale?: string;
}): Promise<RecordScanCode> => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await getOrCreateRecordScanCode({
        ...params,
        code: `gsc_${crypto.common.generateKey(16)}`,
      });
    } catch (error) {
      if (isUniqueViolation(error, "idx_grids_record_scan_codes_code")) continue;
      throw error;
    }
  }
  throw err.internal(getGridsCrudMessages(params.locale).recordScanCollision);
};
