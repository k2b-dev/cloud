import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { processQuiesce } from "@k2b/cloud/services/runtime-quiesce";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { buildMailIndexes, MAIL_CONCURRENT_INDEXES, migrate } from "./migrate";

const suite = suiteFor("database", "nats");

/** Settles within `seconds`, or fails the test instead of letting a start hang until the test timeout. */
const within = <T>(work: Promise<T>, seconds: number): Promise<T> =>
  Promise.race([
    work,
    Bun.sleep(seconds * 1_000).then(() => {
      throw new Error(`Mail's migration did not return within ${seconds}s`);
    }),
  ]);

const valid = async (name: string) => {
  const [row] = await sql<{ valid: boolean }[]>`SELECT coalesce((SELECT indisvalid AND indisready AND indislive FROM pg_index
    WHERE indexrelid = to_regclass(${`mail.${name}`})), false) AS valid`;
  return row!.valid;
};

const buildRuns = async (table: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await sql<{ pid: number }[]>`SELECT pid FROM pg_stat_progress_create_index
      WHERE datname = current_database() AND relid = to_regclass(${table})`;
    if (row) return row.pid;
    await Bun.sleep(25);
  }
  throw new Error(`No index build started on ${table}`);
};

/**
 * A concurrent index build waits for every older snapshot, so a nightly dump can hold it for hours, and it holds its
 * table's SHARE UPDATE EXCLUSIVE lock all that time. Mail's start must never wait for such a build, never fail while
 * one runs elsewhere, and never take a lock that conflicts with it on a table that a build may hold.
 */
suite("mail start next to concurrent index builds", () => {
  beforeAll(async () => {
    await migrate();
  });
  afterAll(async () => {
    expect(await buildMailIndexes()).toBeUndefined();
  });

  test("returns while an old snapshot holds the builds, and builds the indexes after it ends", async () => {
    await sql`DROP INDEX mail.drafts_shared_derived_message_idx`.simple();
    await sql`DROP INDEX mail.drafts_one_open_reply_idx`.simple();
    const snapshot = await sql.reserve();
    let start: Promise<unknown> | undefined;
    try {
      await snapshot`BEGIN ISOLATION LEVEL REPEATABLE READ`.simple();
      await snapshot`SELECT 1`.simple();
      start = migrate();
      await within(start, 20);
      expect(await valid("drafts_one_open_reply_idx")).toBeFalse();
      // The background builds wait for the snapshot without holding Mail's start.
      const building = buildMailIndexes();
      await buildRuns("mail.drafts");
      await snapshot`COMMIT`.simple();
      await building;
    } finally {
      await snapshot`ROLLBACK`.simple();
      await start?.catch(() => undefined);
      snapshot.release();
    }
    expect(await valid("drafts_one_open_reply_idx")).toBeTrue();
    expect(await valid("drafts_shared_derived_message_idx")).toBeTrue();
  });

  test("returns while another backend builds one of its indexes, instead of failing the start", async () => {
    await sql`DROP INDEX mail.drafts_shared_derived_message_idx`.simple();
    const snapshot = await sql.reserve();
    const other = await sql.reserve();
    let running: Promise<string> | undefined;
    let start: Promise<unknown> | undefined;
    try {
      await snapshot`BEGIN ISOLATION LEVEL REPEATABLE READ`.simple();
      await snapshot`SELECT 1`.simple();
      // Another replica's build, left waiting by the snapshot.
      running = other`CREATE INDEX CONCURRENTLY drafts_shared_derived_message_idx ON mail.drafts (derived_from_message_id)
        WHERE edit_mode = 'shared' AND state = 'draft'`
        .simple()
        .then(
          () => "built",
          () => "interrupted",
        );
      await buildRuns("mail.drafts");
      start = migrate();
      await within(start, 20);
      expect(await within(buildMailIndexes(), 5)).toBeUndefined();
      await snapshot`COMMIT`.simple();
      expect(await running).toBe("built");
    } finally {
      await snapshot`ROLLBACK`.simple();
      await running;
      await start?.catch(() => undefined);
      snapshot.release();
      other.release();
    }
    expect(await valid("drafts_shared_derived_message_idx")).toBeTrue();
  });

  test("waits through maintenance stage Ruhe and builds once the Cloud resumes", async () => {
    await sql`DROP INDEX mail.drafts_shared_derived_message_idx`.simple();
    await processQuiesce.quiesce();
    let building: Promise<void> | undefined;
    try {
      building = buildMailIndexes();
      // Long enough for a build that ignored the quiet to have started.
      await Bun.sleep(500);
      expect(await valid("drafts_shared_derived_message_idx")).toBeFalse();
    } finally {
      await processQuiesce.resume();
    }
    await within(building, 20);
    expect(await valid("drafts_shared_derived_message_idx")).toBeTrue();
  });

  test("takes no lock that a running build blocks on any table Mail builds indexes on", async () => {
    const tables = [...new Set(MAIL_CONCURRENT_INDEXES.map((index) => index.table))].sort();
    expect(tables).toContain("mail.drafts");
    const builds = await sql.reserve();
    let start: Promise<unknown> | undefined;
    try {
      await builds`BEGIN`.simple();
      // The lock every concurrent index build holds on its table until it ends.
      await builds.unsafe(`LOCK TABLE ${tables.join(", ")} IN SHARE UPDATE EXCLUSIVE MODE`).simple();
      start = migrate();
      await within(start, 20);
    } finally {
      await builds`ROLLBACK`.simple();
      await start?.catch(() => undefined);
      builds.release();
    }
  });
});
