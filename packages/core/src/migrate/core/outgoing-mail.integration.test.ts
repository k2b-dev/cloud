import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { decryptValue, encryptValue } from "@k2b/cloud/services/settings/crypto";
import { deleteLegacyKeys, listLegacyKeys } from "@k2b/cloud/services/settings/store";
import { SQL } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "./outgoing-mail";

databaseSuite()("outgoing mail migration", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    disposable = await useFreshDatabase("outgoing_mail_migration");
    db = new SQL(disposable.url);
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
