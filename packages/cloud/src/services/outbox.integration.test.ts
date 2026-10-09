import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createPgOutbox } from "./outbox";

// The contract an application relies on with a table of its own, shaped as in "Migrations and transactions".
const schema = `outbox_contract_${crypto.randomUUID().replaceAll("-", "_")}`;
const table = `${schema}.stock_reports`;

type StockReport = { id: string; attempts: number; item_id: string; delta: number };

const reports = (publish: (row: StockReport) => Promise<unknown>, claimMs?: number) =>
  createPgOutbox<StockReport>({
    table,
    name: "outbox-contract",
    orderBy: "item_id",
    sequence: "seq",
    reconcileIntervalMs: 60_000,
    claimMs,
    publish,
  });

const pending = () =>
  sql<{ item_id: string; delta: number; attempts: number; last_error: string | null }[]>`
    SELECT item_id, delta, attempts, last_error FROM ${sql.unsafe(table)} ORDER BY seq
  `;

const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

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
    await sql.unsafe(`CREATE TABLE ${schema}.items (id UUID PRIMARY KEY, quantity INT NOT NULL)`);
    await sql.unsafe(`INSERT INTO ${schema}.items VALUES ('${itemA}', 0)`);
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

    const [before] = await sql<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    await outbox.reconcile();
    expect(published).toEqual([7]);
    const [failed, held] = await pending();
    expect(failed).toMatchObject({ delta: 5, attempts: 1, last_error: "ERP answered 503" });
    expect(held).toMatchObject({ delta: 6, attempts: 0 });
    const [retry] = await sql<{ backed_off: boolean }[]>`
      SELECT next_attempt_at >= ${before?.at}::timestamptz + interval '2 seconds' AS backed_off
      FROM ${sql.unsafe(table)} WHERE attempts = 1
    `;
    expect(retry?.backed_off).toBe(true);

    // Nothing of the key is due before its retry, however long this test takes to get here.
    await sql`UPDATE ${sql.unsafe(table)} SET next_attempt_at = now() + interval '1 hour' WHERE attempts = 1`;
    await outbox.reconcile();
    expect(published).toEqual([7]);

    failing = false;
    await sql`UPDATE ${sql.unsafe(table)} SET next_attempt_at = now()`;
    await outbox.reconcile();
    expect(published).toEqual([7, 5, 6]);
    expect(await pending()).toEqual([]);
  });

  test("rows of one key follow commit order when their writers lock the same row first, and only then", async () => {
    const published: number[] = [];
    const outbox = reports(async (row) => {
      published.push(row.delta);
    });
    // Writer 1 inserts first but commits last; the dispatcher runs in between.
    const interleave = async (lockItem: boolean) => {
      const inserted = gate();
      const commit = gate();
      const changeItem = async (db: typeof sql, delta: number) => {
        if (lockItem) await db`UPDATE ${sql.unsafe(schema)}.items SET quantity = quantity + ${delta} WHERE id = ${itemA}::uuid`;
      };
      const first = sql.begin(async (tx) => {
        await changeItem(tx, 1);
        await report(tx, itemA, 1);
        inserted.open();
        await commit.opened;
      });
      await inserted.opened;
      const second = sql.begin(async (tx) => {
        await changeItem(tx, 2);
        await report(tx, itemA, 2);
      });
      if (!lockItem) await second;
      await outbox.reconcile();
      commit.open();
      await Promise.all([first, second]);
      await outbox.reconcile();
      return published.splice(0);
    };

    // The lock makes the second writer wait, so its row gets the later sequence.
    expect(await interleave(true)).toEqual([1, 2]);
    // Without it, the dispatcher publishes the committed later row before the earlier one exists for it.
    expect(await interleave(false)).toEqual([2, 1]);
    expect(await pending()).toEqual([]);
  });

  test("a batch that outlives its claim starts no further publish and leaves the rest of its key to the next claim", async () => {
    await sql.begin(async (tx) => {
      await report(tx, itemA, 1);
      await report(tx, itemA, 2);
      await report(tx, itemB, 3);
      await report(tx, itemB, 4);
    });
    const log: string[] = [];
    const firstStarted = gate();
    const firstFinishes = gate();
    let firstStarts = 2;
    // Replica 1 publishes the first row of each key past its claim: item A arrives, item B fails.
    const first = reports(async (row) => {
      log.push(`1:${row.delta}`);
      if (--firstStarts === 0) firstStarted.open();
      await firstFinishes.opened;
      if (row.item_id === itemB) throw new Error("ERP timed out");
    }, 200);
    const secondStarted = gate();
    const secondFinishes = gate();
    let secondStarts = 2;
    const second = reports(async (row) => {
      log.push(`2:${row.delta}`);
      if (row.delta === 1 || row.delta === 3) {
        if (--secondStarts === 0) secondStarted.open();
        await secondFinishes.opened;
      }
    });

    const firstPass = first.reconcile();
    let secondPass = Promise.resolve(0);
    try {
      await firstStarted.opened;
      while ((await sql`SELECT FROM ${sql.unsafe(table)} WHERE claimed_until > now()`).length > 0) await Bun.sleep(20);
      secondPass = second.reconcile();
      await secondStarted.opened;
      firstFinishes.open();
      await firstPass;

      // Replica 1 published nothing more, and its failure did not release what replica 2 claimed.
      expect(log.filter((entry) => entry.startsWith("1:")).sort()).toEqual(["1:1", "1:3"]);
      const claimed = await sql<{ delta: number }[]>`SELECT delta FROM ${sql.unsafe(table)} WHERE claimed_until > now() ORDER BY seq`;
      expect(claimed.map((row) => row.delta)).toEqual([2, 4]);
    } finally {
      firstFinishes.open();
      secondFinishes.open();
      await Promise.all([firstPass, secondPass]);
    }
    const byReplica2 = log.filter((entry) => entry.startsWith("2:")).map((entry) => Number(entry.slice(2)));
    expect(byReplica2.filter((delta) => delta <= 2)).toEqual([1, 2]);
    expect(byReplica2.filter((delta) => delta >= 3)).toEqual([3, 4]);
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
