import { expect, spyOn, test } from "bun:test";
import { createSql, sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { lockDraftDocumentCoverage } from "./draft-document-log";
import { awaitDraftDocumentQuery, stopDraftDocumentCancellation, withDraftDocumentTransaction } from "./draft-document-socket-sql";

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

  test("aborting every reserved connection settles both helpers, reuses the pool and closes it", async () => {
    const capacity = sql.options.max;
    if (!capacity) throw new Error("Native SQL did not expose its configured pool capacity");
    const observer = createSql({ max: 1 });
    const stopped = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const backends: number[] = [];
    const reservations: Awaited<ReturnType<typeof sql.reserve>>[] = [];
    const reserve = sql.reserve.bind(sql);
    const reserveSpy = spyOn(sql, "reserve").mockImplementation(async (...args) => {
      const connection = await reserve(...args);
      reservations.push(connection);
      return connection;
    });
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.allSettled(
      Array.from({ length: capacity }, () =>
        withDraftDocumentTransaction(stopped.signal, async (db) => {
          const [row] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          backends.push(row!.pid);
          if (backends.length === capacity) entered.resolve();
          await release.promise;
        }),
      ),
    ).then((results) => {
      finished = true;
      return results;
    });
    try {
      await entered.promise;
      stopped.abort(new Error("Every socket closed together"));
      release.resolve();
      const results = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cancellation waited for its own full pool")), 5000);
        }),
      ]);
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(
        await observer`SELECT pid FROM pg_stat_activity WHERE pid IN ${observer(backends)} AND state LIKE 'idle in transaction%'`,
      ).toHaveLength(0);
      expect((await sql<{ ready: number }[]>`SELECT 1 AS ready`)[0]?.ready).toBe(1);
      await stopDraftDocumentCancellation();
      // Mail integration files run in isolation; this is the file's last test.
      await expect(sql.close()).resolves.toBeUndefined();
    } finally {
      clearTimeout(timer);
      reserveSpy.mockRestore();
      // Only on regression: free this fixture's slots so its expected failure
      // does not strand teardown. Production waits for cancellation before reuse.
      if (!finished) for (const connection of reservations) connection.release();
      release.resolve();
      await work;
      await stopDraftDocumentCancellation();
      await observer.close();
    }
  });
});
