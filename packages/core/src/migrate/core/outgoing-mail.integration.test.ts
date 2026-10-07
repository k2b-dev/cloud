import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
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
  test("uses port 587 when it was not stored", async () => {
    await seed("smtp_host", "smtp.example.org");
    await seed("from", "noreply@example.org");
    await migrate(db);
    expect((await db`SELECT smtp_port, smtp_secure FROM outgoing_mail.profiles`)[0]).toEqual({ smtp_port: 587, smtp_secure: false });
  });
  test("leaves unconfigured installations empty", async () => {
    await migrate(db);
    expect(await db`SELECT * FROM outgoing_mail.profiles`).toHaveLength(0);
    await seed("smtp_host", "");
    await migrate(db);
    expect(await db`SELECT * FROM outgoing_mail.profiles`).toHaveLength(0);
  });
});
