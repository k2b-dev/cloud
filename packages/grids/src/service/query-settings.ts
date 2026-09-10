import { app } from "../config";

export type QuerySettings = { poolSize: number; concurrency: number; queueLimit: number; queueTimeoutMs: number };

/** One immutable settings snapshot per process; changes apply on restart. */
let snapshot: Promise<QuerySettings> | undefined;

export const getQuerySettings = (): Promise<QuerySettings> =>
  (snapshot ??= Promise.all([
    app.settings.get("grids.query_pool_size"),
    app.settings.get("grids.query_concurrency"),
    app.settings.get("grids.query_queue_limit"),
    app.settings.get("grids.query_queue_timeout_ms"),
  ]).then(([poolSize, concurrency, queueLimit, queueTimeoutMs]) => ({
    poolSize,
    concurrency: concurrency === 0 ? poolSize : Math.min(concurrency, poolSize),
    queueLimit,
    queueTimeoutMs,
  })));
