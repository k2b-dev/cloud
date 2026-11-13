import { expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { lockDraftDocumentCoverage } from "./draft-document-log";
import { awaitDraftDocumentQuery, withDraftDocumentTransaction } from "./draft-document-socket-sql";

const suite = suiteFor("database", "nats");

suite("Mail draft SQL cancellation", () => {
  test("abort between coverage and the lazy row query releases the transaction and pool reservation", async () => {
    const stopped = new AbortController();
    const reason = new Error("Socket closed after coverage lock");
    let backend: number | undefined;
    const work = withDraftDocumentTransaction(stopped.signal, async (db) => {
      const [row] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      backend = row!.pid;
      await lockDraftDocumentCoverage(db);
      // This was the idle transaction's last executed statement in the teardown
      // repro. Cancelling the next lazy query before then() never settled it.
      stopped.abort(reason);
      return awaitDraftDocumentQuery(db`SELECT 1`, stopped.signal);
    });
    await expect(work).rejects.toBe(reason);
    const open = await sql`SELECT pid FROM pg_stat_activity
      WHERE pid = ${backend!} AND state LIKE 'idle in transaction%'`;
    expect(open).toHaveLength(0);
    expect((await sql<{ ready: number }[]>`SELECT 1 AS ready`)[0]?.ready).toBe(1);
  });

  test("abort cancels an executing native query and rolls back before releasing it", async () => {
    const stopped = new AbortController();
    let backend: number | undefined;
    const entered = Promise.withResolvers<void>();
    const work = withDraftDocumentTransaction(stopped.signal, async (db) => {
      const [row] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      backend = row!.pid;
      const query = awaitDraftDocumentQuery(db`SELECT pg_sleep(10)`, stopped.signal);
      entered.resolve();
      return query;
    });
    // Attach rejection handling before allowing cancellation.
    const settled = work.then(
      () => false,
      () => true,
    );
    await entered.promise;
    const deadline = Date.now() + 5000;
    while (!(await sql`SELECT 1 FROM pg_stat_activity WHERE pid = ${backend!} AND wait_event = 'PgSleep'`).length) {
      if (Date.now() >= deadline) throw new Error("Native cancellation fixture did not start its query");
      await Bun.sleep(1);
    }
    stopped.abort(new Error("Socket closed while reading"));
    expect(await settled).toBe(true);
    expect(await sql`SELECT pid FROM pg_stat_activity WHERE pid = ${backend!} AND state LIKE 'idle in transaction%'`).toHaveLength(0);
    expect((await sql<{ ready: number }[]>`SELECT 1 AS ready`)[0]?.ready).toBe(1);
  });
});
