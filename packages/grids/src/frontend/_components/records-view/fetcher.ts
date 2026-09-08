/**
 * Typed wrapper around POST /api/grids/tables/:tableId/query. Returns whichever of
 * { items, aggregates, buckets, nextCursor, explode } the RecordQuery
 * requested.
 *
 * Threads an AbortSignal through so rapid query changes cancel
 * in-flight network calls instead of leaving obsolete work on the server.
 */

import { apiClient } from "../../../api/client";
import type { PublicTableQueryResult as TableQueryResult } from "../../../api/public-dto";
import type { RecordQuery, TableQueryBody } from "../../../contracts";
import { errorMessage } from "../utils/api-helpers";

type FetchTableQueryArgs = {
  tableId: string;
  viewId?: string;
  query: RecordQuery;
  cursor: string | null;
  filePreviewFieldIds?: string[];
};

/**
 * Custom error so callers can distinguish HTTP failures (server-side
 * rejection of the query) from network-level errors (offline,
 * AbortError). The status code is exposed for consumers that want to
 * surface 400-vs-500 differently in the UI.
 */
export class TableQueryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TableQueryError";
  }
}

export const buildTableQueryBody = (args: FetchTableQueryArgs): TableQueryBody => ({
  query: args.query,
  viewId: args.viewId,
  cursor: args.cursor ?? undefined,
  filePreviewFieldIds: args.filePreviewFieldIds,
});

export const fetchTableQuery = async (args: FetchTableQueryArgs, opts: { signal?: AbortSignal } = {}): Promise<TableQueryResult> => {
  const body = buildTableQueryBody(args);
  // Hono's RPC client takes RequestInit as the second positional arg —
  // signal lives there alongside any future header / credentials needs.
  const res = await apiClient.tables[":tableId"].query.$post(
    { param: { tableId: args.tableId }, json: body },
    { init: { signal: opts.signal } },
  );
  if (!res.ok) {
    throw new TableQueryError(res.status, await errorMessage(res, "Could not load records."));
  }
  return res.json();
};
