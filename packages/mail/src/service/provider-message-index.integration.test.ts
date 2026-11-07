import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SQL } from "bun";
import { createDisposableDatabase, ownTestDatabase, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { buildCommandTargetIndex, buildProviderMessageIndex } from "../migrate";
import { providerMessageLookupQuery } from "./provider-message-lookup";

const suite = suiteFor("database", "nats");
const resourceId = "00000000-0000-4000-8000-000000000001";
const setup = async (db: SQL) => {
  // Only lookup columns; mirror the existing indexes, with no artificial planner settings.
  await db`CREATE SCHEMA mail`;
  await db`CREATE TABLE mail.folders (id uuid PRIMARY KEY, remote_resource_id uuid, parent_id uuid, name text)`;
  await db`CREATE INDEX folders_resource_parent_idx ON mail.folders (remote_resource_id, parent_id, name)`;
  await db`CREATE TABLE mail.remote_message_refs (id uuid PRIMARY KEY, folder_id uuid, message_id uuid,
    uid_validity numeric, uid numeric, connector_ref jsonb NOT NULL, stale_at timestamptz)`;
  await db`CREATE UNIQUE INDEX ON mail.remote_message_refs (folder_id, uid_validity, uid)`;
  await db`CREATE INDEX remote_message_refs_folder_scan_idx ON mail.remote_message_refs (folder_id, uid_validity, uid DESC) WHERE stale_at IS NULL`;
  await db`CREATE INDEX remote_message_refs_message_idx ON mail.remote_message_refs (message_id, folder_id)`;
  await db`CREATE TABLE mail.commands (mailbox_id uuid, target jsonb, kind text)`;
};

suite("provider message indexes", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  beforeAll(async () => {
    database = await createDisposableDatabase("mail_provider_indexes");
    ownTestDatabase(database.name);
    const db = new SQL(database.url);
    try {
      await setup(db);
    } finally {
      await db.close();
    }
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("generic provider-message lookup seeks a matching expression at 80,227 messages and 354 folders", async () => {
    const db = new SQL(database.url, { max: 2 });
    try {
      await db`INSERT INTO mail.folders SELECT md5(n::text)::uuid, ${resourceId}::uuid, NULL, 'Folder ' || n FROM generate_series(1,354) n`;
      await db`INSERT INTO mail.remote_message_refs
        SELECT md5(('ref' || n)::text)::uuid, md5((1 + n % 354)::text)::uuid, md5(('msg' || n)::text)::uuid,
          1, n, jsonb_build_object('providerMessageId', 'provider-' || n), NULL FROM generate_series(1,80227) n`;
      // Legacy or malformed provider IDs must not make the build or future inserts fail at
      // B-tree's entry-size limit; matching still compares the complete ID after its hash.
      const longId = Array.from({ length: 128 }, (_, n) => createHash("sha256").update(`provider-fixture:${n}`).digest("hex")).join("");
      await db`INSERT INTO mail.remote_message_refs (id, folder_id, message_id, uid_validity, uid, connector_ref)
        VALUES (md5('longref')::uuid, md5('1')::uuid, md5('longmsg')::uuid, 1, 90000, ${{ providerMessageId: longId }}::jsonb)`;
      await db`ANALYZE mail.folders`;
      await db`ANALYZE mail.remote_message_refs`;
      const explain = (query = providerMessageLookupQuery) =>
        db.begin(async (tx) => {
          await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
          await tx.unsafe(`PREPARE provider_lookup(uuid,text) AS ${query}`).simple();
          try {
            const result = await tx
              .unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE provider_lookup('${resourceId}', 'provider-40227')`)
              .simple();
            return JSON.stringify(result);
          } finally {
            await tx`DEALLOCATE provider_lookup`.simple();
          }
        });
      const before = await explain(
        providerMessageLookupQuery.replace("    AND md5(remote_ref.connector_ref ->> 'providerMessageId') = md5($2::text)\n", ""),
      );
      const rawFailure =
        await db`CREATE INDEX oversized_provider_key ON mail.remote_message_refs ((connector_ref ->> 'providerMessageId'))`.then(
          () => null,
          (error: unknown) => (error instanceof SQL.PostgresError ? error.errno : "unexpected error"),
        );
      expect(rawFailure).toBe("54000");
      expect(before).not.toContain("remote_message_refs_provider_message_idx");
      expect(await buildProviderMessageIndex(db)).toBe("built");
      await db`ANALYZE mail.remote_message_refs`;
      const after = await explain();
      console.info("provider lookup generic plans", { before, after });
      expect(after).toContain("remote_message_refs_provider_message_idx");
      expect(after).toContain("$2");
      expect(await db.unsafe(providerMessageLookupQuery, [resourceId, "provider-40227"])).toHaveLength(1);
      expect(await db.unsafe(providerMessageLookupQuery, ["00000000-0000-4000-8000-000000000002", "provider-40227"])).toHaveLength(0);
      expect(await db.unsafe(providerMessageLookupQuery, [resourceId, longId])).toHaveLength(1);
      await db`UPDATE mail.remote_message_refs SET connector_ref = ${{ providerMessageId: longId + "changed" }}::jsonb WHERE uid = 90000`;
      expect(await db.unsafe(providerMessageLookupQuery, [resourceId, longId])).toHaveLength(0);
      expect(await db.unsafe(providerMessageLookupQuery, [resourceId, longId + "changed"])).toHaveLength(1);
      expect(await buildProviderMessageIndex(db)).toBe("ready");
    } finally {
      await db.close();
    }
  });

  for (const [name, builder, table] of [
    ["provider", buildProviderMessageIndex, "remote_message_refs"],
    ["command", buildCommandTargetIndex, "commands"],
  ] as const) {
    test(`${name} build reserves its connection while ordinary pool queries and table writes finish`, async () => {
      const pool = new SQL(database.url, { max: 2 });
      const monitor = new SQL(database.url, { max: 2 });
      const blocker = await monitor.reserve();
      let build: ReturnType<typeof builder> | undefined;
      let probes: Promise<unknown> | undefined;
      try {
        if (name === "provider") await pool`DROP INDEX IF EXISTS mail.remote_message_refs_provider_message_idx`;
        await blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`.simple();
        await blocker.unsafe(`SELECT * FROM mail.${table}`).simple();
        build = builder(pool);
        let waiting = false;
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          const [progress] = await monitor<
            { phase: string }[]
          >`SELECT phase FROM pg_stat_progress_create_index WHERE datname = current_database()`;
          if (progress?.phase === "waiting for old snapshots") {
            waiting = true;
            break;
          }
          await Bun.sleep(25);
        }
        expect(waiting).toBe(true);
        expect(await builder(pool)).toBe("busy");
        probes = Promise.all(Array.from({ length: 4 }, () => pool`SELECT 1`.execute()));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            probes,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Foreground query queued behind background DDL")), 3_000);
            }),
          ]);
          await monitor
            .unsafe(
              `INSERT INTO mail.${table} (${table === "commands" ? "target" : "id, connector_ref"}) VALUES (${table === "commands" ? "'{}'::jsonb" : "'00000000-0000-4000-8000-000000000003', '{}'::jsonb"})`,
            )
            .simple();
        } finally {
          clearTimeout(timer);
        }
      } finally {
        try {
          await blocker`ROLLBACK`.simple();
        } finally {
          blocker.release();
          await Promise.allSettled([build, probes]);
          await Promise.allSettled([pool.close(), monitor.close()]);
        }
      }
      expect(await build).toBe("built");
    });
  }
});
