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
 * With `sequence`, it works in batches: claims of one outbox (table and
 * `where`) take turns, a claim takes rows in sequence order with several rows
 * per ordering key, and the dispatcher publishes keys concurrently and the
 * rows of one key in order, then completes the batch in one statement. A row
 * that never failed is due at once. Claims stay proportional to the batch
 * with an index on the `where` columns and `sequence`, and one on the `where`
 * columns and `orderBy` limited to `claimed_until IS NOT NULL OR attempts > 0`.
 *
 * Required columns: `id uuid`, `attempts int`, `next_attempt_at timestamptz`,
 * `claimed_until timestamptz`, `delivered_at timestamptz`, `last_error text`,
 * `created_at timestamptz`. `maxAttempts` additionally needs `dead_at`;
 * `onDelivered: "delete"` needs no `delivered_at`.
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
  /** Schema-qualified table, e.g. `events.outbox`. */
  table: string;
  /** Log source. */
  name: string;
  publish: (row: Row) => Promise<unknown>;
  reconcileIntervalMs: number;
  /**
   * Column whose rows must be delivered in insertion order. A pending earlier
   * row with the same value blocks later ones until it is delivered or dead.
   * With `sequence`, a value waits while any of its rows is claimed or waits
   * for a retry.
   */
  orderBy?: Extract<keyof Row, string>;
  /** Fixed column values every claimed row matches, e.g. `{ kind: "live", app_id: "contacts" }`. */
  where?: Readonly<Record<string, string>>;
  /** Insertion-order column that orders claims instead of `(created_at, id)`, and enables batches (see above). */
  sequence?: string;
  /** Delete a published row instead of setting `delivered_at`; every row in the table is then pending. */
  onDelivered?: "delete";
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
  const sequence = config.sequence ? identifier(config.sequence, "sequence column") : null;
  const deleteDelivered = config.onDelivered === "delete";
  const notDead = maxAttempts === null ? sql`` : sql`AND dead_at IS NULL`;
  const earlierNotDead = maxAttempts === null ? sql`` : sql`AND earlier.dead_at IS NULL`;
  const pending = deleteDelivered ? sql`` : sql`AND delivered_at IS NULL`;
  const earlierPending = deleteDelivered ? sql`` : sql`AND earlier.delivered_at IS NULL`;
  const filters = Object.entries(config.where ?? {}).map(([column, value]) => ({ column: identifier(column, "filter column"), value }));
  const matches = (alias: "current" | "earlier" | "busy") =>
    filters.reduce((fragment, { column, value }) => sql`${fragment} AND ${sql.unsafe(alias)}.${column} = ${value}`, sql``);
  // Rows without an ordering column are independent: each is a key of its own.
  const runKey = config.orderBy ?? "id";
  const runColumn = identifier(runKey, "ordering column");
  const claimLock = `${config.table}:${JSON.stringify(config.where ?? {})}`;

  /**
   * Claims rows in sequence order, several per key, and never a row of a key
   * that has a claimed row or one waiting for a retry. `next_attempt_at` only
   * delays retries: it is the writer's transaction start, so a fresh row that
   * committed later can carry an earlier one, or one after this claim began.
   */
  const claimBatch = (cap: number, order: ReturnType<typeof sql.unsafe>) =>
    sql.begin(async (tx) => {
      // Claims take turns: a concurrent claim would skip this one's locked rows and take later rows of the same keys.
      // A claim that outlives its claim period is worthless, so neither a slow statement nor a vanished client holds the turn longer.
      await tx`
        SELECT set_config('statement_timeout', ${String(claimMs)}, true),
               set_config('idle_in_transaction_session_timeout', ${String(claimMs)}, true),
               pg_advisory_xact_lock(hashtextextended(${claimLock}, 0))
      `;
      // The busy probe runs per candidate (OFFSET 0 keeps the planner from turning it into a join, which
      // stale statistics can make quadratic), against an index of claimed and retried rows per key.
      return tx<Row[]>`
        WITH candidates AS MATERIALIZED (
          SELECT current.id
          FROM ${table} current
          WHERE (current.attempts = 0 OR current.next_attempt_at <= now())
            AND (current.claimed_until IS NULL OR current.claimed_until <= now())
            ${pending}
            ${notDead}
            ${matches("current")}
            AND NOT EXISTS (
              SELECT
              FROM ${table} busy
              WHERE busy.${runColumn} = current.${runColumn}
                AND (busy.claimed_until > now() OR (busy.attempts > 0 AND busy.next_attempt_at > now()))
                ${pending}
                ${notDead}
                ${matches("busy")}
              OFFSET 0
            )
          ORDER BY current.${order}
          LIMIT ${cap}
          FOR UPDATE SKIP LOCKED
        ), claimed AS (
          UPDATE ${table} outbox
          SET claimed_until = now() + (${claimMs} * interval '1 millisecond')
          FROM candidates
          WHERE outbox.id = candidates.id
          RETURNING outbox.*
        )
        SELECT * FROM claimed ORDER BY ${order}
      `;
    });

  const claim: PgOutbox<Row>["claim"] = async (limit = batchSize) => {
    const cap = Math.min(Math.max(limit, 1), batchSize);
    if (sequence !== null) return claimBatch(cap, sequence);
    const ordered =
      orderBy === null
        ? sql``
        : sql`
          AND NOT EXISTS (
            SELECT 1
            FROM ${table} earlier
            WHERE earlier.${orderBy} = current.${orderBy}
              ${earlierPending}
              ${earlierNotDead}
              ${matches("earlier")}
              AND (earlier.created_at, earlier.id) < (current.created_at, current.id)
          )
        `;
    // One statement: the CTE claim and the update commit atomically.
    return sql<Row[]>`
      WITH candidates AS MATERIALIZED (
        SELECT current.id
        FROM ${table} current
        WHERE current.next_attempt_at <= now()
          AND (current.claimed_until IS NULL OR current.claimed_until <= now())
          ${pending}
          ${notDead}
          ${matches("current")}
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

  const retryLater = async (row: Row, error: unknown) => {
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
      WHERE id = ${row.id}::uuid ${pending} ${notDead} AND attempts = ${row.attempts}
    `;
    log.warn("Outbox delivery failed", { outboxId: row.id, attempts, error: message });
  };

  const dispatch: PgOutbox<Row>["dispatch"] = async (row, publish = config.publish) => {
    try {
      await publish(row);
      if (deleteDelivered) {
        await sql`DELETE FROM ${table} WHERE id = ${row.id}::uuid AND attempts = ${row.attempts}`;
        return;
      }
      await sql`
        UPDATE ${table}
        SET delivered_at = now(), claimed_until = NULL, last_error = NULL
        WHERE id = ${row.id}::uuid ${pending} ${notDead} AND attempts = ${row.attempts}
      `;
    } catch (error) {
      await retryLater(row, error);
    }
  };

  /** Publishes a claimed batch: keys concurrently, the rows of one key in order. A failed row releases the rest of its key. */
  const dispatchBatch = async (rows: Row[]) => {
    const delivered: string[] = [];
    const runs = Map.groupBy(rows, (row) => row[runKey]);
    const results = await Promise.allSettled(
      [...runs.values()].map(async (run) => {
        for (const [index, row] of run.entries()) {
          try {
            await config.publish(row);
          } catch (error) {
            await retryLater(row, error);
            const rest = run.slice(index + 1).map((later) => later.id);
            if (rest.length > 0) await sql`UPDATE ${table} SET claimed_until = NULL WHERE id = ANY(${sql.array(rest, "uuid")})`;
            return;
          }
          delivered.push(row.id);
        }
      }),
    );
    if (delivered.length > 0) {
      const ids = sql.array(delivered, "uuid");
      await (deleteDelivered
        ? sql`DELETE FROM ${table} WHERE id = ANY(${ids})`
        : sql`UPDATE ${table} SET delivered_at = now(), claimed_until = NULL, last_error = NULL WHERE id = ANY(${ids})`);
    }
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };

  let activeReconcile: Promise<number> | null = null;
  let reconcileRequested = false;

  const reconcile: PgOutbox<Row>["reconcile"] = () => {
    reconcileRequested = true;
    if (activeReconcile) return activeReconcile;
    activeReconcile = (async () => {
      if (!deleteDelivered) {
        const deadExpired = maxAttempts === null ? sql`` : sql`OR dead_at < now() - ${DEAD_RETENTION}::interval`;
        await sql`
          DELETE FROM ${table}
          WHERE delivered_at < now() - ${DELIVERED_RETENTION}::interval
             ${deadExpired}
        `;
      }
      let processed = 0;
      let rows: Row[];
      do {
        reconcileRequested = false;
        rows = await claim();
        if (sequence !== null) await dispatchBatch(rows);
        // Sequential: across keys, the claim order is the publish order.
        else for (const row of rows) await dispatch(row);
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
