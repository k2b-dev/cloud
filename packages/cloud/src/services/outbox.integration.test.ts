import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createPgOutbox } from "./outbox";

// The contract an application relies on with a table of its own, shaped as in "Migrations and transactions".
const schema = `outbox_contract_${crypto.randomUUID().replaceAll("-", "_")}`;
const table = `${schema}.stock_reports`;

type StockReport = { id: string; attempts: number; item_id: string; delta: number };

const reports = (publish: (row: StockReport) => Promise<unknown>) =>
  createPgOutbox<StockReport>({
    table,
    name: "outbox-contract",
    orderBy: "item_id",
    sequence: "seq",
    reconcileIntervalMs: 60_000,
    publish,
  });

const pending = () =>
  sql<{ item_id: string; delta: number; attempts: number; last_error: string | null; retry_in: number }[]>`
    SELECT item_id, delta, attempts, last_error, EXTRACT(EPOCH FROM next_attempt_at - now())::int AS retry_in
    FROM ${sql.unsafe(table)} ORDER BY seq
  `;

const report = (db: typeof sql, itemId: string, delta: number) =>
  db`INSERT INTO ${sql.unsafe(table)} (item_id, delta) VALUES (${itemId}::uuid, ${delta})`;

const itemA = crypto.randomUUID();
const itemB = crypto.randomUUID();

suiteFor("database")("Postgres outbox on an application table", () => {
  beforeAll(async () => {
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`
      CREATE TABLE ${table} (
        seq             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id              UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        item_id         UUID NOT NULL,
        delta           INT NOT NULL,
        attempts        INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        claimed_until   TIMESTAMPTZ,
        last_error      TEXT
      )
    `);
    await sql.unsafe(`CREATE INDEX ON ${table} (item_id) WHERE claimed_until IS NOT NULL OR attempts > 0`);
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  test("a rollback leaves nothing; a commit publishes every column once, in order per key, and deletes the row", async () => {
    await sql
      .begin(async (tx) => {
        await report(tx, itemA, 1);
        throw new Error("domain write failed");
      })
      .catch(() => undefined);
    expect(await pending()).toEqual([]);

    await sql.begin(async (tx) => {
      await report(tx, itemA, 2);
      await report(tx, itemB, 3);
      await report(tx, itemA, 4);
    });
    const published: Array<Pick<StockReport, "item_id" | "delta">> = [];
    expect(await reports(async (row) => published.push({ item_id: row.item_id, delta: row.delta })).reconcile()).toBe(3);
    expect(published.filter((row) => row.item_id === itemA).map((row) => row.delta)).toEqual([2, 4]);
    expect(published).toContainEqual({ item_id: itemB, delta: 3 });
    expect(await pending()).toEqual([]);
  });

  test("a failed publish keeps its row for a retry, holds back its key, and lets other keys through", async () => {
    await sql.begin(async (tx) => {
      await report(tx, itemA, 5);
      await report(tx, itemA, 6);
      await report(tx, itemB, 7);
    });
    const published: number[] = [];
    let failing = true;
    const outbox = reports(async (row) => {
      if (failing && row.item_id === itemA) throw new Error("ERP answered 503");
      published.push(row.delta);
    });

    await outbox.reconcile();
    expect(published).toEqual([7]);
    const [failed, held] = await pending();
    expect(failed).toMatchObject({ delta: 5, attempts: 1, last_error: "ERP answered 503" });
    expect(failed?.retry_in).toBeGreaterThan(0);
    expect(held).toMatchObject({ delta: 6, attempts: 0 });

    // Nothing of the key is due before its retry.
    await outbox.reconcile();
    expect(published).toEqual([7]);

    failing = false;
    await sql`UPDATE ${sql.unsafe(table)} SET next_attempt_at = now()`;
    await outbox.reconcile();
    expect(published).toEqual([7, 5, 6]);
    expect(await pending()).toEqual([]);
  });

  test("notify() logs a failing pass instead of throwing, and stop() waits for the pass in flight", async () => {
    await report(sql, itemB, 8);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const published: number[] = [];
    const outbox = reports(async (row) => {
      await blocked;
      published.push(row.delta);
    });
    outbox.start();
    const stopped = outbox.stop();
    release();
    await stopped;
    expect(published).toEqual([8]);
    expect(await pending()).toEqual([]);

    const broken = createPgOutbox<StockReport>({
      table: `${schema}.missing`,
      name: "outbox-contract",
      orderBy: "item_id",
      sequence: "seq",
      reconcileIntervalMs: 60_000,
      publish: async () => {},
    });
    await expect(broken.reconcile()).rejects.toThrow();
    await expect(broken.notify()).resolves.toBeUndefined();
  });
});
