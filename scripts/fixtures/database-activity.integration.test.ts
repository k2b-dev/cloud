import { expect } from "bun:test";
import { SQL } from "bun";
import { describeDatabaseActivity } from "./database-activity";
import { testFor, testInfra } from "./test-infra";

const postgresTest = testFor("database");

postgresTest("names a running statement, what it waits on and who blocks it", async () => {
  const url = testInfra.database!;
  const holder = new SQL({ url, max: 1 });
  const waiter = new SQL({ url, max: 1 });
  const key = Math.floor(Math.random() * 1_000_000_000);
  try {
    const held = await holder.reserve();
    await held`SELECT pg_advisory_lock(${key}::bigint)`;
    const [{ pid }] = await held<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const waiting = waiter`SELECT pg_advisory_lock(${key}::bigint)`.then(() => waiter`SELECT pg_advisory_unlock(${key}::bigint)`);
    let report = "";
    for (let attempt = 0; attempt < 100 && !report.includes(`blocked by ${pid}`); attempt += 1) {
      report = await describeDatabaseActivity(url);
      await Bun.sleep(50);
    }
    expect(report).toContain(`blocked by ${pid}`);
    expect(report).toContain("wait=Lock:advisory");
    expect(report).toContain("SELECT pg_advisory_lock");
    await held`SELECT pg_advisory_unlock(${key}::bigint)`;
    await waiting;
    held.release();
  } finally {
    await Promise.all([holder.close(), waiter.close()]);
  }
});

postgresTest("says so when it cannot reach the server instead of failing the run", async () => {
  expect(await describeDatabaseActivity("postgres://nobody:nobody@127.0.0.1:1/none_test")).toStartWith("Database activity unavailable:");
});
