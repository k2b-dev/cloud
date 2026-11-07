import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDisposableDatabase, suiteFor } from "../../scripts/fixtures/test-infra";

suiteFor("database")("late test-infrastructure cancellation", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let directory: string;
  beforeAll(async () => {
    database = await createDisposableDatabase("guard_rejection");
    directory = await mkdtemp(join(tmpdir(), "cloud-guard-rejection-"));
    const infra = join(import.meta.dir, "../../scripts/fixtures/test-infra.ts");
    await writeFile(
      join(directory, "guard.test.ts"),
      `import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SQL } from "bun";
import { ownTestDatabase, endLingeringTestWork } from ${JSON.stringify(infra)};
let releaseIdle;
const client = new SQL(process.env.CLOUD_TEST_DATABASE_URL, { max: 2, onclose: () => releaseIdle?.() });
// Claiming a database in beforeAll must protect callbacks already registered.
beforeAll(async () => {
  ownTestDatabase(new URL(process.env.CLOUD_TEST_DATABASE_URL).pathname.slice(1));
  await client\`CREATE TABLE IF NOT EXISTS guard_probe (id int)\`;
});
afterAll(() => client.close());
// Restoring ordinary mocks must leave the fixture's module shim installed.
mock.restore();
if (process.env.GUARD_CASE === "cancel") {
  let interrupted;
  const kinds = ["active", "active", "idle"];
  beforeEach(async () => {
    const kind = kinds.shift();
    if (!kind) return;
    const work = kind === "active" ? client\`SELECT pg_sleep(30)\`.execute() : client.begin(async tx => {
      await tx\`LOCK TABLE guard_probe IN ACCESS EXCLUSIVE MODE\`;
      await new Promise(resolve => { releaseIdle = resolve; });
    });
    interrupted = work.catch(error => error);
    // Establish the guard's actual condition before the deliberately short
    // callback budget starts, so connection/scheduling delays cannot race it.
    for (const deadline = performance.now() + 2000; ; ) {
      const [row] = await client\`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state = \${kind === "active" ? "active" : "idle in transaction"}
          AND state_change < now() - interval '250 milliseconds'\`;
      if (row.n) break;
      if (performance.now() > deadline) throw new Error("work never reached the guard threshold");
      await Bun.sleep(20);
    }
  });
  test.each([1])("active statement %i", async () => { throw await interrupted; }, 100);
  describe("hook", () => {
    beforeEach(async () => { throw await interrupted; }, 100);
    test("timed out hook", () => {});
  });
  test("idle transaction", async () => { throw await interrupted; }, 100);
} else {
  test("ordinary SQL error", async () => { await client\`SELECT * FROM guard_missing_relation\`; });
  test("ordinary cancellation error", async () => {
    await client.unsafe("DO $$ BEGIN RAISE EXCEPTION 'ordinary-cancel' USING ERRCODE='57014'; END $$");
  });
  test("explicit guard cancellation remains a failure", async () => {
    const running = client\`SELECT pg_sleep(30)\`.execute();
    // Observe immediately, but still propagate the error to the test callback.
    const observed = running.catch(error => error);
    for (const deadline = performance.now() + 2000; ; ) {
      const [row] = await client\`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND query = 'SELECT pg_sleep(30)'
          AND state = 'active' AND state_change < now() - interval '250 milliseconds'\`;
      if (row.n) break;
      if (performance.now() > deadline) throw new Error("statement never became active");
      await Bun.sleep(20);
    }
    await endLingeringTestWork();
    throw await observed;
  });
}
test.if(true)("next test recovers", async () => {
  await client\`TRUNCATE guard_probe\`;
  expect((await client\`SELECT 1 AS n\`)[0].n).toBe(1);
});
`,
    );
  });
  afterAll(async () => {
    if (database) await database.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test.each(["cancel", "errors"])("%s keeps the original failures and lets the next test run", async (mode) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "test",
        "--preload",
        join(import.meta.dir, "../../scripts/fixtures/test-infra.ts"),
        "guard.test.ts",
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          BUN_OPTIONS: "--no-env-file",
          CLOUD_TEST_DATABASE_URL: database.url,
          GUARD_CASE: mode,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = stdout + stderr;
    expect(exitCode, output).toBe(1);
    expect(output).toContain("3 fail");
    expect(output).toContain("(pass) next test recovers");
    expect(output).not.toContain("Unhandled error between tests");
    if (mode === "cancel") {
      expect(output).toContain("this test timed out after 100ms");
      expect(output).toContain("a beforeEach/afterEach hook timed out");
      expect(output).toContain("cancelled active work");
      expect(output).toContain("ended idle in transaction work");
      expect(output.match(/the guard ended a timed-out callback/g), output).toHaveLength(3);
    } else {
      expect(output).toContain('relation "guard_missing_relation" does not exist');
      expect(output).toContain("ordinary-cancel");
      expect(output).toContain("(fail) explicit guard cancellation remains a failure");
      expect(output).not.toContain("the guard ended a timed-out callback");
    }
  });
});
