import { fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";

/**
 * Live-parent invariant helpers. The grids service contract is:
 *
 *   non-trash reads return only resources whose entire parent chain is
 *   alive. Restore paths require parent-chain alive; otherwise restore
 *   the parent first (top-down).
 *
 * Most read paths enforce this by JOINing the parent chain in their
 * SELECT. Mutating paths (restore, soft-delete) do a separate
 * preflight via these helpers because UPDATE ... FROM ... is more
 * verbose than a one-liner SELECT EXISTS.
 *
 * All checks return `Result<void>`: `ok()` when the parent chain is
 * alive, or `err.conflict(...)` when something in the parent chain is
 * trashed (the API layer translates conflict to 409).
 */

/** Record mutations are only valid for stored tables. Federated tables are
 * read models; their publication grants never authorize writes to sources. */
export const requireStoredTableWritable = async (tableId: string, client: SqlClient = sql, locale?: string): Promise<Result<void>> => {
  const [row] = await client<{ kind: string }[]>`
    SELECT t.kind
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.id = ${tableId}::uuid AND t.deleted_at IS NULL
    FOR SHARE OF t, b
  `;
  if (!row) {
    return fail({
      code: "CONFLICT",
      message: getGridsCrudMessages(locale).parentTrashed,
      status: 409,
    });
  }
  return row.kind === "stored"
    ? ok()
    : fail({
        code: "BAD_INPUT",
        message: getGridsCrudMessages(locale).combinedReadOnly,
        status: 400,
      });
};

/**
 * JOIN fragment for target-record reads that must obey the same live-parent
 * invariant as records.list/get. Aliases are internal constants at call sites;
 * keep this helper private to service SQL assembly, never pass user input.
 */
export const liveRecordParentJoinSql = (recordAlias: string, tableAlias: string, baseAlias: string) =>
  sql.unsafe(`
  JOIN grids.tables ${tableAlias} ON ${tableAlias}.id = ${recordAlias}.table_id AND ${tableAlias}.deleted_at IS NULL
  JOIN grids.bases ${baseAlias} ON ${baseAlias}.id = ${tableAlias}.base_id AND ${baseAlias}.deleted_at IS NULL
`);
