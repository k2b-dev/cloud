import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { runBoundedQuery, stopBoundedQueryPool } from "./bounded-query";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

afterAll(stopBoundedQueryPool);

describe("bounded query", () => {
  postgresTest("keeps transaction-local data and settings without sharing other snapshots", async () => {
    const results = await Promise.all(
      [1, 2].map((value) =>
        sql.begin(async (tx) => {
          await tx`CREATE TEMP TABLE bounded_snapshot (value int) ON COMMIT DROP`;
          await tx`INSERT INTO bounded_snapshot VALUES (${value})`;
          await tx`SET LOCAL statement_timeout = '9s'`;
          const rows = await runBoundedQuery<{ value: number }>(
            sql`SELECT value FROM bounded_snapshot`,
            1_000,
            undefined,
            "same-snapshot-key",
            tx,
          );
          const [settings] = await tx<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
          expect(settings?.timeout).toBe("9s");
          return rows;
        }),
      ),
    );
    expect(results).toEqual([[{ value: 1 }], [{ value: 2 }]]);
  });

  postgresTest("preserves transaction timeout and abort errors for the caller to roll back", async () => {
    await expect(
      sql.begin(async (tx) => {
        await runBoundedQuery(sql`SELECT pg_sleep(1)`, 20, undefined, undefined, tx);
      }),
    ).rejects.toThrow("statement timeout");
    const controller = new AbortController();
    await expect(
      sql.begin(async (tx) => {
        const pending = runBoundedQuery(sql`SELECT pg_sleep(5)`, 10_000, controller.signal, undefined, tx);
        await Bun.sleep(30);
        controller.abort();
        await pending;
      }),
    ).rejects.toThrow("query aborted");
    expect(await runBoundedQuery<{ answer: number }>(sql`SELECT 42::int AS answer`, 1_000)).toEqual([{ answer: 42 }]);
  });

  postgresTest("cancels an admitted statement when its request is aborted", async () => {
    const controller = new AbortController();
    const pending = runBoundedQuery(sql`SELECT pg_sleep(5)`, 10_000, controller.signal);
    await Bun.sleep(20);
    controller.abort();

    await expect(pending).rejects.toThrow("query aborted");
    expect(await runBoundedQuery<{ answer: number }>(sql`SELECT 42::int AS answer`, 1_000)).toEqual([{ answer: 42 }]);
  });

  postgresTest("releases the connection after concurrent success and timeout", async () => {
    const rows = await runBoundedQuery<{ answer: number }>(sql`SELECT 42::int AS answer`, 1_000);
    expect(rows).toEqual([{ answer: 42 }]);

    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { sql } from "bun";
          import { runBoundedQuery, stopBoundedQueryPool } from "./bounded-query";
          const timedOut = await Promise.allSettled(
            Array.from({ length: 20 }, () => runBoundedQuery(sql\`SELECT pg_sleep(1)\`, 20)),
          );
          const timeoutCount = timedOut.filter((result) =>
            result.status === "rejected" && /statement timeout/i.test(result.reason.message)
          ).length;
          if (timeoutCount === 0) process.exit(2);
          const recovered = await Promise.all(
            Array.from({ length: 50 }, () =>
              runBoundedQuery(sql\`SELECT 42::int AS answer\`, 1_000)
            ),
          );
          if (!recovered.every(([row]) => row?.answer === 42)) process.exit(3);
          await stopBoundedQueryPool();
          await sql.close();
          console.log(\`bounded-query-ok:\${timeoutCount}\`);
        `,
      ],
      {
        cwd: import.meta.dir,
        env: process.env,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    if (exitCode !== 0) throw new Error(`bounded query child exited ${exitCode}: ${stdout}`);
    expect(stdout).toContain("bounded-query-ok");
  });

  postgresTest("recreates its pool after runtime shutdown", async () => {
    expect(await runBoundedQuery<{ answer: number }>(sql`SELECT 42::int AS answer`, 1_000)).toEqual([{ answer: 42 }]);
    await stopBoundedQueryPool();
    expect(await runBoundedQuery<{ answer: number }>(sql`SELECT 43::int AS answer`, 1_000)).toEqual([{ answer: 43 }]);
  });

  postgresTest("shares only overlapping reads with the same dedupe key", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        runBoundedQuery<{ value: string }>(sql`SELECT gen_random_uuid()::text AS value`, 1_000, undefined, "shared-read"),
      ),
    );
    expect(new Set(results.map(([row]) => row?.value)).size).toBe(1);

    const afterCompletion = await runBoundedQuery<{ value: string }>(
      sql`SELECT gen_random_uuid()::text AS value`,
      1_000,
      undefined,
      "shared-read",
    );
    expect(afterCompletion[0]?.value).not.toBe(results[0]?.[0]?.value);
  });

  postgresTest("keeps a shared read alive while another caller is still waiting", async () => {
    const controller = new AbortController();
    const aborted = runBoundedQuery<{ answer: number }>(
      sql`SELECT 42::int AS answer FROM pg_sleep(0.1)`,
      1_000,
      controller.signal,
      "independent-abort",
    );
    const completed = runBoundedQuery<{ answer: number }>(
      sql`SELECT 42::int AS answer FROM pg_sleep(0.1)`,
      1_000,
      undefined,
      "independent-abort",
    );
    await Bun.sleep(20);
    controller.abort();

    await expect(aborted).rejects.toThrow("query aborted");
    expect(await completed).toEqual([{ answer: 42 }]);
  });
});
