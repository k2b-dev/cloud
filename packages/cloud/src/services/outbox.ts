import { sql } from "bun";
import { logger } from "./logging";

/**
 * PostgreSQL transactional-outbox dispatcher.
 *
 * Domain writers insert a row in their own transaction; this dispatcher claims
 * pending rows (`FOR UPDATE SKIP LOCKED`), publishes them, and records
 * delivery or an exponential-backoff retry. Rows stay durable until they are
 * delivered (or dead after `maxAttempts`, when the table has a `dead_at`
 * column), and delivered rows are pruned after a retention period.
 *
 * Required columns: `id uuid`, `attempts int`, `next_attempt_at timestamptz`,
 * `claimed_until timestamptz`, `delivered_at timestamptz`, `last_error text`,
 * `created_at timestamptz`. `maxAttempts` additionally needs `dead_at`.
 */

const DEFAULT_CLAIM_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const DELIVERED_RETENTION = "7 days";
const DEAD_RETENTION = "30 days";
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export type OutboxRow = {
  id: string;
  attempts: number;
};

export type PgOutboxConfig<Row extends OutboxRow> = {
  /** Schema-qualified table, e.g. `mail.live_invalidation_outbox`. */
  table: string;
  /** Log source. */
  name: string;
  publish: (row: Row) => Promise<unknown>;
  reconcileIntervalMs: number;
  /**
   * Column whose rows must be delivered in insertion order. A pending earlier
   * row with the same value blocks later ones until it is delivered or dead.
   */
  orderBy?: string;
  /** Mark rows dead after this many failed attempts (requires `dead_at`). */
  maxAttempts?: number;
  claimMs?: number;
  batchSize?: number;
};

export type PgOutbox<Row extends OutboxRow> = {
  claim(limit?: number): Promise<Row[]>;
  dispatch(row: Row, publish?: (row: Row) => Promise<unknown>): Promise<void>;
  /** Drain every claimable row; concurrent calls join the active pass. */
  reconcile(): Promise<number>;
  /** `reconcile()` with failures logged instead of thrown. */
  notify(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

const identifier = (name: string, label: string): ReturnType<typeof sql.unsafe> => {
  if (!name.split(".").every((part) => IDENTIFIER.test(part))) throw new Error(`Invalid outbox ${label}: ${name}`);
  return sql.unsafe(name);
};

export const createPgOutbox = <Row extends OutboxRow>(config: PgOutboxConfig<Row>): PgOutbox<Row> => {
  const table = identifier(config.table, "table");
  const orderBy = config.orderBy ? identifier(config.orderBy, "ordering column") : null;
  const maxAttempts = config.maxAttempts ?? null;
  const claimMs = config.claimMs ?? DEFAULT_CLAIM_MS;
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = logger(config.name);
  const notDead = maxAttempts === null ? sql`` : sql`AND dead_at IS NULL`;
  const earlierNotDead = maxAttempts === null ? sql`` : sql`AND earlier.dead_at IS NULL`;

  const claim: PgOutbox<Row>["claim"] = async (limit = batchSize) => {
    const cap = Math.min(Math.max(limit, 1), batchSize);
    const ordered =
      orderBy === null
        ? sql``
        : sql`
          AND NOT EXISTS (
            SELECT 1
            FROM ${table} earlier
            WHERE earlier.${orderBy} = current.${orderBy}
              AND earlier.delivered_at IS NULL
              ${earlierNotDead}
              AND (earlier.created_at, earlier.id) < (current.created_at, current.id)
          )
        `;
    // One statement: the CTE claim and the update commit atomically.
    return sql<Row[]>`
      WITH candidates AS MATERIALIZED (
        SELECT current.id
        FROM ${table} current
        WHERE current.delivered_at IS NULL
          ${notDead}
          AND current.next_attempt_at <= now()
          AND (current.claimed_until IS NULL OR current.claimed_until <= now())
          ${ordered}
        ORDER BY current.next_attempt_at, current.created_at, current.id
        LIMIT ${cap}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${table} outbox
      SET claimed_until = now() + (${claimMs} * interval '1 millisecond')
      FROM candidates
      WHERE outbox.id = candidates.id
      RETURNING outbox.*
    `;
  };

  const dispatch: PgOutbox<Row>["dispatch"] = async (row, publish = config.publish) => {
    try {
      await publish(row);
      await sql`
        UPDATE ${table}
        SET delivered_at = now(), claimed_until = NULL, last_error = NULL
        WHERE id = ${row.id}::uuid AND delivered_at IS NULL ${notDead} AND attempts = ${row.attempts}
      `;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 8));
      const dead = maxAttempts === null ? sql`` : sql`dead_at = CASE WHEN ${attempts} >= ${maxAttempts} THEN now() ELSE dead_at END,`;
      await sql`
        UPDATE ${table}
        SET attempts = ${attempts},
            next_attempt_at = now() + (${delaySeconds} * interval '1 second'),
            claimed_until = NULL,
            ${dead}
            last_error = ${message.slice(0, 1_000)}
        WHERE id = ${row.id}::uuid AND delivered_at IS NULL ${notDead} AND attempts = ${row.attempts}
      `;
      log.warn("Outbox delivery failed", { outboxId: row.id, attempts, error: message });
    }
  };

  let activeReconcile: Promise<number> | null = null;
  let reconcileRequested = false;

  const reconcile: PgOutbox<Row>["reconcile"] = () => {
    reconcileRequested = true;
    if (activeReconcile) return activeReconcile;
    activeReconcile = (async () => {
      const deadExpired = maxAttempts === null ? sql`` : sql`OR dead_at < now() - ${DEAD_RETENTION}::interval`;
      await sql`
        DELETE FROM ${table}
        WHERE delivered_at < now() - ${DELIVERED_RETENTION}::interval
           ${deadExpired}
      `;
      let processed = 0;
      let rows: Row[];
      do {
        reconcileRequested = false;
        rows = await claim();
        // Sequential: a claimed batch may contain ordered rows of one key.
        for (const row of rows) await dispatch(row);
        processed += rows.length;
      } while (reconcileRequested || rows.length > 0);
      return processed;
    })().finally(() => {
      activeReconcile = null;
    });
    return activeReconcile;
  };

  const notify: PgOutbox<Row>["notify"] = async () => {
    await reconcile().catch((error) => {
      log.warn("Outbox reconcile failed", { error: error instanceof Error ? error.message : String(error) });
    });
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  const start: PgOutbox<Row>["start"] = () => {
    if (timer) return;
    timer = setInterval(() => void notify(), config.reconcileIntervalMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    void notify();
  };

  const stop: PgOutbox<Row>["stop"] = async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await activeReconcile;
  };

  return { claim, dispatch, reconcile, notify, start, stop };
};
