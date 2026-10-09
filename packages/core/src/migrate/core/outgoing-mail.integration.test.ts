import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { bindProcessSync, unbindProcessSync } from "@k2b/cloud";
import { decryptValue, encryptValue } from "@k2b/cloud/services/settings/crypto";
import { deleteLegacyKeys, listLegacyKeys } from "@k2b/cloud/services/settings/store";
import { createSync } from "@k2b/sync";
import { SQL } from "bun";
import { connectTestNats, databaseSuite, testFor, testSyncNamespace, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../../../../scripts/fixtures/test-sync";
import { migrate as migrateLogging } from "./logging";
import { buildSearchIndexes, migrate } from "./outgoing-mail";

databaseSuite()("outgoing mail migration", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    disposable = await useFreshDatabase("outgoing_mail_migration");
    db = new SQL(disposable.url);
    // The background index build reports through Core's log.
    await migrateLogging();
  });
  beforeEach(async () => {
    await db`DROP SCHEMA IF EXISTS outgoing_mail CASCADE`.simple();
    await db`CREATE SCHEMA IF NOT EXISTS settings`.simple();
    await db`CREATE TABLE IF NOT EXISTS settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.simple();
    await db`DELETE FROM settings.entries`;
  });
  afterAll(async () => {
    await db?.close();
    await disposable?.drop();
  });
  const searchIndexes = () =>
    db<{ name: string; valid: boolean }[]>`SELECT c.relname AS name, i.indisvalid AS valid FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('outgoing_mail_messages_search', 'outgoing_mail_messages_recipients') ORDER BY c.relname`;
  const advisoryLocks = async () => {
    const [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_locks
      WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    return row?.count;
  };
  const buildStarted = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const [row] = await db<{ pid: number }[]>`SELECT pid FROM pg_stat_progress_create_index
        WHERE relid = to_regclass('outgoing_mail.messages')`;
      if (row) return row.pid;
      await Bun.sleep(25);
    }
    throw new Error("The index build did not start");
  };
  /** The background build coordinates through a NATS lease, as in a running Core. */
  const withProcessSync = async (run: () => Promise<void>) => {
    const connection = await connectTestNats({ ignoreClusterUpdates: true });
    const namespace = testSyncNamespace("outgoing-mail-indexes");
    const sync = createSync({ connection, namespace, application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    try {
      await sync.ready();
      await run();
    } finally {
      unbindProcessSync();
      await sync.drain();
      await deleteTestNamespace(namespace);
      await connection.drain();
    }
  };
  const seed = async (key: string, value: unknown) => {
    const ciphertext = await encryptValue(value);
    await db`INSERT INTO settings.entries(key, value) VALUES (${`mail.noreply.${key}`}, ${ciphertext})`;
    return ciphertext;
  };
  test("creates the schema when a waiting migrator cached it as missing", async () => {
    const first = new SQL({ url: disposable.url, max: 1 });
    const stale = new SQL({ url: disposable.url, max: 1 });
    const holder = new SQL({ url: disposable.url, max: 1 });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    const waitForLock = async (pid: number, locktype: "relation" | "advisory") => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [row] = await db<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT FROM pg_locks WHERE pid = ${pid} AND locktype = ${locktype} AND NOT granted
            AND (${locktype} = 'advisory' OR relation = 'settings.entries'::regclass)
        ) AS waiting`;
        if (row?.waiting) return;
        await Bun.sleep(10);
      }
      throw new Error(`Migrator ${pid} did not wait on the ${locktype} lock before the deadline`);
    };
    try {
      const [firstBackend] = await first<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const [staleBackend] = await stale<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!firstBackend || !staleBackend) throw new Error("Missing migrator backend PID");
      // Keep the negative schema-cache entry on the connection that will lose the lock race.
      await stale`DROP SCHEMA IF EXISTS outgoing_mail CASCADE`.simple();
      await seed("smtp_host", "smtp.example.org");
      const holding = holder.begin(async (tx) => {
        await tx`LOCK TABLE settings.entries IN ACCESS EXCLUSIVE MODE`.simple();
        locked.resolve();
        await release.promise;
      });
      pending.push(holding);
      void holding.catch(() => {});
      await Promise.race([locked.promise, holding]);
      const migratingFirst = migrate(first);
      pending.push(migratingFirst);
      void migratingFirst.catch(() => {});
      // The first migrator has created the schema but cannot commit until its legacy read finishes.
      await waitForLock(firstBackend.pid, "relation");
      const migratingStale = migrate(stale);
      pending.push(migratingStale);
      void migratingStale.catch(() => {});
      await waitForLock(staleBackend.pid, "advisory");
      release.resolve();
      await Promise.all([holding, migratingFirst, migratingStale]);
      expect(await db<{ key: string }[]>`SELECT key FROM outgoing_mail.profiles`).toEqual([{ key: "noreply" }]);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      await Promise.all([first.close(), stale.close(), holder.close()]);
    }
  }, 15_000);
  test("imports legacy SMTP settings once and preserves authenticated password ciphertext", async () => {
    await seed("smtp_host", "smtp.example.org");
    await seed("smtp_port", 465);
    await seed("from", "noreply@example.org");
    await seed("user", "smtp-user");
    const ciphertext = await seed("password", "a-working-password");
    await Promise.all([migrate(db), migrate(db)]);
    const rows = await db`SELECT * FROM outgoing_mail.profiles`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "noreply",
      name: "No-reply",
      from_address: "noreply@example.org",
      from_name: null,
      smtp_port: 465,
      smtp_secure: true,
      smtp_user: "smtp-user",
      smtp_password_encrypted: ciphertext,
      is_default: true,
      pace_per_minute: 60,
      daily_recipient_limit: null,
      max_attachment_bytes: 15728640,
      revision: 1,
    });
    expect(await decryptValue(rows[0].smtp_password_encrypted)).toBe("a-working-password");
    await migrate(db);
    expect(await db`SELECT * FROM outgoing_mail.profiles`).toEqual(rows);
    expect(await deleteLegacyKeys()).toEqual({ deleted: [] });
    expect(await listLegacyKeys()).toEqual([]);
    expect(await db`SELECT * FROM settings.entries`).toHaveLength(5);
  });
  test("adds an idempotent send log even when profiles already exist", async () => {
    await seed("smtp_host", "smtp.example.org");
    await seed("from", "noreply@example.org");
    await migrate(db);
    await db`DROP TABLE IF EXISTS outgoing_mail.messages`.simple();
    await Promise.all([migrate(db), migrate(db)]);
    const [index] = await db<{ name: string | null }[]>`SELECT to_regclass('outgoing_mail.outgoing_mail_messages_batch')::text AS name`;
    expect(index?.name).toBe("outgoing_mail.outgoing_mail_messages_batch");
    for (const name of ["outgoing_mail_messages_bulk_due", "outgoing_mail_messages_bulk_deadline"]) {
      const [index] = await db<{ name: string | null }[]>`SELECT to_regclass(${`outgoing_mail.${name}`})::text AS name`;
      expect(index?.name).toBe(`outgoing_mail.${name}`);
    }
    const [table] = await db<{ name: string | null }[]>`SELECT to_regclass('outgoing_mail.messages')::text AS name`;
    expect(table?.name).toBe("outgoing_mail.messages");
    const [profile] = await db<{ id: string }[]>`SELECT id FROM outgoing_mail.profiles`;
    const insert = async (
      id: string,
    ) => db`INSERT INTO outgoing_mail.messages(id, app_id, profile_id, profile_key, lane, idempotency_key, to_addresses, recipient_count, subject, message_id_header, status, deadline_at)
      VALUES (${id}::uuid, 'inventory', ${profile!.id}::uuid, 'noreply', 'immediate', 'key', ARRAY['reader@example.org'], 1, 'Hello', ${`<${id}@example.org>`}, 'queued', now() + INTERVAL '24 hours')`;
    await insert(crypto.randomUUID());
    await expect(insert(crypto.randomUUID())).rejects.toThrow();
    await db`DELETE FROM outgoing_mail.profiles`;
    expect((await db`SELECT profile_id, profile_key, attachments, attempt_count FROM outgoing_mail.messages`)[0]).toMatchObject({
      profile_id: null,
      profile_key: "noreply",
      attachments: [],
      attempt_count: 0,
    });
  });

  test("adds nullable IMAP columns repeatedly to populated profiles and validates ports", async () => {
    await seed("smtp_host", "smtp.example.org");
    await seed("from", "noreply@example.org");
    await migrate(db);
    for (const column of [
      "imap_host",
      "imap_port",
      "imap_secure",
      "imap_user",
      "imap_password_encrypted",
      "imap_folder",
      "imap_uid_validity",
      "imap_last_uid",
      "imap_checked_at",
      "imap_error",
    ])
      await db.unsafe(`ALTER TABLE outgoing_mail.profiles DROP COLUMN ${column}`);
    await Promise.all([migrate(db), migrate(db)]);
    expect(
      await db<Record<string, unknown>[]>`SELECT imap_host, imap_port, imap_secure, imap_user, imap_password_encrypted, imap_folder,
      imap_uid_validity, imap_last_uid, imap_checked_at, imap_error FROM outgoing_mail.profiles`,
    ).toEqual([
      {
        imap_host: null,
        imap_port: null,
        imap_secure: null,
        imap_user: null,
        imap_password_encrypted: null,
        imap_folder: null,
        imap_uid_validity: null,
        imap_last_uid: null,
        imap_checked_at: null,
        imap_error: null,
      },
    ]);
    // A Bun SQL query runs once awaited; `expect().rejects` alone would never start it.
    for (const port of [0, 65536])
      await expect((async () => await db`UPDATE outgoing_mail.profiles SET imap_port = ${port}`)()).rejects.toThrow();
    await db`UPDATE outgoing_mail.profiles SET imap_port = 993, imap_uid_validity = 4294967295, imap_last_uid = 4294967295`;
    await migrate(db);
    expect(
      await db<
        Record<string, unknown>[]
      >`SELECT imap_port, imap_uid_validity::text AS validity, imap_last_uid::text AS uid FROM outgoing_mail.profiles`,
    ).toEqual([{ imap_port: 993, validity: "4294967295", uid: "4294967295" }]);
  });
  test("log grants and immutable search functions are additive and repeatable", async () => {
    await migrate(db);
    await db`INSERT INTO outgoing_mail.app_log_access(app_id, source_app_id, created_by)
      VALUES ('reader', 'source', 'admin')`;
    await Promise.all([migrate(db), migrate(db)]);
    expect(await db<Record<string, unknown>[]>`SELECT app_id, source_app_id, created_by FROM outgoing_mail.app_log_access`).toEqual([
      { app_id: "reader", source_app_id: "source", created_by: "admin" },
    ]);
    // Setup leaves the search indexes to the background build, so Core starts without waiting for them.
    expect(await searchIndexes()).toEqual([]);
    expect(
      await db<Record<string, unknown>[]>`SELECT proname, provolatile, proparallel FROM pg_catalog.pg_proc
      WHERE pronamespace = 'outgoing_mail'::regnamespace AND proname IN ('search_text', 'lower_addresses') ORDER BY proname`,
    ).toEqual([
      { proname: "lower_addresses", provolatile: "i", proparallel: "s" },
      { proname: "search_text", provolatile: "i", proparallel: "s" },
    ]);
    await db.begin(async (tx) => {
      await tx`SET LOCAL search_path = pg_catalog`.simple();
      expect(
        await tx<
          Record<string, unknown>[]
        >`SELECT outgoing_mail.search_text('SUBJECT', ARRAY['USER@Example.org', 'SECOND@example.org']) AS search,
        outgoing_mail.lower_addresses(ARRAY['USER@Example.org', 'SECOND@example.org']) AS addresses`,
      ).toEqual([{ search: "subject\nuser@example.org\nsecond@example.org", addresses: ["user@example.org", "second@example.org"] }]);
      expect(await tx<Record<string, unknown>[]>`SELECT outgoing_mail.lower_addresses(ARRAY[]::text[]) AS addresses`).toEqual([
        { addresses: [] },
      ]);
    });
    for (const [reader, source] of [
      ["reader", "reader"],
      ["reader", "core"],
      ["reader", "source"],
    ])
      await expect(
        (async () => await db`INSERT INTO outgoing_mail.app_log_access(app_id, source_app_id) VALUES (${reader}, ${source})`)(),
      ).rejects.toThrow();
  });
  test("a setup during a concurrent index build neither waits for it nor makes new mail wait", async () => {
    await migrate(db);
    // Fails within two seconds instead of queuing behind the build and taking new mail with it.
    const impatient = new SQL({ url: disposable.url, max: 2, connection: { lock_timeout: "2000" } });
    const build = await db.reserve();
    try {
      // CREATE INDEX CONCURRENTLY holds this lock for as long as the build runs.
      await build`BEGIN`.simple();
      await build`LOCK TABLE outgoing_mail.messages IN SHARE UPDATE EXCLUSIVE MODE`.simple();
      await migrate(impatient);
    } finally {
      await build`ROLLBACK`.simple();
      build.release();
      await impatient.close();
    }
  });
  testFor("database", "nats")("builds the search indexes in the background, one process at a time, without session locks", async () => {
    await withProcessSync(async () => {
      await migrate(db);
      const writer = await db.reserve();
      try {
        // An open write keeps a concurrent build waiting, so the second start sees the first one build.
        await writer`BEGIN`.simple();
        await writer`LOCK TABLE outgoing_mail.messages IN ROW EXCLUSIVE MODE`.simple();
        const first = buildSearchIndexes(db);
        await buildStarted();
        expect(await buildSearchIndexes(db)).toBe("busy");
        expect(await advisoryLocks()).toBe(0);
        await writer`COMMIT`.simple();
        expect(await first).toBe("built");
      } finally {
        await writer`ROLLBACK`.simple();
        writer.release();
      }
      expect(await searchIndexes()).toEqual([
        { name: "outgoing_mail_messages_recipients", valid: true },
        { name: "outgoing_mail_messages_search", valid: true },
      ]);
      expect(await buildSearchIndexes(db)).toBe("ready");
      // The index serves the search it was built for.
      await db.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`.simple();
        const plan = await tx`EXPLAIN (FORMAT JSON) SELECT id FROM outgoing_mail.messages
          WHERE outgoing_mail.search_text(subject, to_addresses) ILIKE '%invoice%'`;
        expect(JSON.stringify(plan)).toContain("outgoing_mail_messages_search");
      });
    });
  });
  testFor("database", "nats")("leaves a build another process runs alone and replaces an interrupted one", async () => {
    await withProcessSync(async () => {
      await migrate(db);
      expect(await buildSearchIndexes(db)).toBe("built");
      await db`DROP INDEX outgoing_mail.outgoing_mail_messages_search`.simple();
      const writer = await db.reserve();
      const other = await db.reserve();
      try {
        await writer`BEGIN`.simple();
        await writer`LOCK TABLE outgoing_mail.messages IN ROW EXCLUSIVE MODE`.simple();
        const running =
          other`CREATE INDEX CONCURRENTLY outgoing_mail_messages_search ON outgoing_mail.messages USING gin (subject gin_trgm_ops)`
            .simple()
            .then(
              () => "built",
              () => "interrupted",
            );
        const pid = await buildStarted();
        expect(await buildSearchIndexes(db)).toBe("busy");
        // An interrupted build leaves an invalid index, which the next start replaces.
        await db`SELECT pg_cancel_backend(${pid}::int)`;
        expect(await running).toBe("interrupted");
        await writer`COMMIT`.simple();
      } finally {
        await writer`ROLLBACK`.simple();
        writer.release();
        other.release();
      }
      expect(await searchIndexes()).toContainEqual({ name: "outgoing_mail_messages_search", valid: false });
      expect(await buildSearchIndexes(db)).toBe("built");
      expect(await searchIndexes()).toContainEqual({ name: "outgoing_mail_messages_search", valid: true });
    });
  });
  test("uses port 587 when it was not stored", async () => {
    await seed("smtp_host", "smtp.example.org");
    await seed("from", "noreply@example.org");
    await migrate(db);
    expect((await db`SELECT smtp_port, smtp_secure FROM outgoing_mail.profiles`)[0]).toEqual({ smtp_port: 587, smtp_secure: false });
  });
  test("an undecryptable legacy host does not prevent setup and imports no profile", async () => {
    await db`INSERT INTO settings.entries(key, value) VALUES ('mail.noreply.smtp_host', 'deadbeef')`;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(migrate(db)).resolves.toBeUndefined();
      expect(await db`SELECT * FROM outgoing_mail.profiles`).toHaveLength(0);
      expect(warn.mock.calls).toEqual([["[setup] outgoing-mail: ignored undecryptable legacy setting mail.noreply.smtp_host"]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("deadbeef");
    } finally {
      warn.mockRestore();
    }
  });
  test("an undecryptable legacy password is omitted without exposing stored values", async () => {
    const host = await seed("smtp_host", "smtp.example.org");
    const from = await seed("from", "noreply@example.org");
    await db`INSERT INTO settings.entries(key, value) VALUES ('mail.noreply.password', 'deadbeef')`;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(migrate(db)).resolves.toBeUndefined();
      expect(await db<{ smtp_password_encrypted: string | null }[]>`SELECT smtp_password_encrypted FROM outgoing_mail.profiles`).toEqual([
        { smtp_password_encrypted: null },
      ]);
      expect(warn.mock.calls).toEqual([["[setup] outgoing-mail: ignored undecryptable legacy setting mail.noreply.password"]]);
      for (const value of ["deadbeef", host, from, "smtp.example.org", "noreply@example.org"])
        expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
    } finally {
      warn.mockRestore();
    }
  });
  test.each([0, "abc", 70000, 587.5])("invalid legacy port %s falls back to 587", async (port) => {
    await seed("smtp_host", "smtp.example.org");
    await seed("from", "noreply@example.org");
    await seed("smtp_port", port);
    await expect(migrate(db)).resolves.toBeUndefined();
    expect(await db<{ smtp_port: number; smtp_secure: boolean }[]>`SELECT smtp_port, smtp_secure FROM outgoing_mail.profiles`).toEqual([
      { smtp_port: 587, smtp_secure: false },
    ]);
  });
  test("a legacy port stored as a numeric string keeps its value", async () => {
    await seed("smtp_host", "smtp.example.org");
    await seed("from", "noreply@example.org");
    await seed("smtp_port", "2525");
    await migrate(db);
    expect((await db`SELECT smtp_port FROM outgoing_mail.profiles`)[0]).toEqual({ smtp_port: 2525 });
  });
  test("undecryptable legacy port, from and user fall back independently", async () => {
    await seed("smtp_host", "smtp.example.org");
    for (const key of ["smtp_port", "from", "user"])
      await db`INSERT INTO settings.entries(key, value) VALUES (${`mail.noreply.${key}`}, 'deadbeef')`;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(migrate(db)).resolves.toBeUndefined();
      expect(
        await db<
          { smtp_port: number; smtp_secure: boolean; from_address: string; smtp_user: string | null }[]
        >`SELECT smtp_port, smtp_secure, from_address, smtp_user FROM outgoing_mail.profiles`,
      ).toEqual([{ smtp_port: 587, smtp_secure: false, from_address: "", smtp_user: null }]);
      expect(warn.mock.calls).toEqual(
        ["smtp_port", "from", "user"].map((key) => [`[setup] outgoing-mail: ignored undecryptable legacy setting mail.noreply.${key}`]),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("deadbeef");
    } finally {
      warn.mockRestore();
    }
  });
  test("non-string legacy sender, user and password values are omitted", async () => {
    await seed("smtp_host", "smtp.example.org");
    await seed("from", { address: "must-not-escape" });
    await seed("user", 123);
    const ciphertext = await seed("password", { secret: "must-not-escape" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await migrate(db);
      expect(
        await db<
          { from_address: string; smtp_user: string | null; smtp_password_encrypted: string | null }[]
        >`SELECT from_address, smtp_user, smtp_password_encrypted FROM outgoing_mail.profiles`,
      ).toEqual([{ from_address: "", smtp_user: null, smtp_password_encrypted: null }]);
      expect(warn.mock.calls).toEqual([["[setup] outgoing-mail: ignored invalid legacy setting mail.noreply.password"]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-escape");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ciphertext);
    } finally {
      warn.mockRestore();
    }
  });
  test("leaves unconfigured installations empty", async () => {
    await migrate(db);
    expect(await db`SELECT * FROM outgoing_mail.profiles`).toHaveLength(0);
    await seed("smtp_host", "");
    await migrate(db);
    expect(await db`SELECT * FROM outgoing_mail.profiles`).toHaveLength(0);
  });
});
