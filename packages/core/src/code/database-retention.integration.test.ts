import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import * as storedSettings from "@k2b/cloud/services/settings";
import type { SQL } from "bun";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../migrate/core/audit";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import { migrate as migrateActivation } from "../migrate/core/code-activation";
import { migrate as migrateSettings } from "../migrate/core/settings";
import type { CodeContext } from "./access";
import { readCodeDatabaseUsage } from "./database";
import { codeDatabaseOwnerCapacity } from "./database-budget";
import type { CodeDatabaseClient } from "./database-client";
import { DATABASE_EXPIRY_NOTICE_MS, readDatabaseDeadline } from "./database-deadline";
import {
  deleteUnusedCodeDatabase,
  expireUnusedCodeDatabases,
  listUnusedCodeDatabases,
  notifyUnusedCodeDatabases,
  processDatabaseDeletion,
} from "./database-retention";
import { codeDatabaseSettings } from "./database-settings";
import { CODE_SETTINGS, codeSettings } from "./settings";

const owner = "11111111-1111-4111-8111-111111111111";
const fixed = new Date("2026-12-01T12:00:00.000Z");
const since = new Date("2026-11-01T12:00:00.000Z");
const user: User = {
  id: owner,
  uid: "owner",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Owner",
  displayName: "Test Owner",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const context: CodeContext = {
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: owner }, credentialKind: "session", scopes: [] },
};
const signal = () => new AbortController().signal;

databaseSuite()("Unused Code database retention", () => {
  let db: Awaited<ReturnType<typeof useFreshDatabase>>;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let retentionSetting: ReturnType<typeof spyOn<typeof storedSettings, "read">>;
  let connection: ReturnType<typeof spyOn<typeof codeDatabaseSettings, "read">>;
  let days = 30;
  let ordinal = 0;
  const removed: string[] = [];
  const client: CodeDatabaseClient = {
    create: async () => {},
    configure: async () => {},
    execute: async () => [],
    size: async () => 4096,
    remove: async (ns) => {
      removed.push(ns);
    },
    export: async () => new Response(),
  };
  async function version(id: string, number: number, database = false, executor: SQL = sql) {
    const [v] = await executor<
      { id: string }[]
    >`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes)
      VALUES(${id},${number},'{}','fixture',${"a".repeat(64)},${"b".repeat(64)},${JSON.stringify({ database })}::text::jsonb,0,7) RETURNING id`;
    return v!.id;
  }
  async function age(id: string) {
    await sql`UPDATE code.databases SET unused_since=${since},unused_shown_at=${since},unused_delete_at=${fixed},unused_days=30,
      unused_policy_revision=(SELECT revision FROM code.database_retention_policy WHERE singleton) WHERE code_id=${id}`;
  }
  async function changeDays(value: number) {
    days = value;
    // Exercise the same transaction hook as settings API/CLI writes, without encrypted fixture secrets.
    await sql`INSERT INTO settings.entries(key,value) VALUES('core.code.database_unused_days',${String(value)})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`;
  }
  async function fixture(kind: "person" | "resource" | "app" = "person") {
    const id = `c_exp${String(++ordinal).padStart(4, "0")}`;
    if (kind === "person") {
      await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state) VALUES(${id},'person',${owner}::uuid,'Unused database','paused')`;
    } else {
      const ownerId = `fixture${ordinal}`;
      const name = kind === "app" ? `code:app:${ownerId}` : `code:example.item:${ownerId}`;
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind) VALUES(${name},'code') RETURNING id`;
      await sql`INSERT INTO code.codes(id,owner_kind,owner_type,owner_id,owner_app_id,service_account_id,title,state)
        VALUES(${id},${kind},${kind === "resource" ? "example.item" : null},${kind === "resource" ? ownerId : null},
          ${kind === "app" ? ownerId : null},${account!.id}::uuid,'Unused database','paused')`;
    }
    await version(id, 1);
    await sql`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes,connected,last_size_bytes)
      VALUES(${id},${`code_${id}`},'http://rsql.test',104857600,TRUE,4096)`;
    await age(id);
    return id;
  }
  const unused = async (id: string) =>
    (await sql<{ unused_since: Date | null }[]>`SELECT unused_since FROM code.databases WHERE code_id=${id}`)[0]?.unused_since;
  const confirmation = async (id: string) => ({ codeId: id, namespace: `code_${id}`, since: (await unused(id))!.toISOString() });
  beforeAll(async () => {
    setSystemTime(fixed);
    db = await useFreshDatabase("core_code_database_retention");
    await migrateAuth();
    await migrateAudit();
    await migrateCode();
    await migrateActivation();
    await migrateCode();
    await migrateSettings();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${owner}::uuid,'owner','local','user',TRUE)`;
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) =>
      key === "core.code.database_unused_days" ? days : CODE_SETTINGS[key].default,
    );
    retentionSetting = spyOn(storedSettings, "read").mockImplementation(async () => ({
      value: days,
      stored: "readable" as const,
    }));
    const values = {
      "core.code.rsql_url": "http://rsql.test",
      "core.code.rsql_api_token": "fixture",
      "core.code.rsql_allowed_targets": ["rsql.test"],
    };
    connection = spyOn(codeDatabaseSettings, "read").mockImplementation(async <K extends keyof typeof values>(key: K) => ({
      value: values[key],
      stored: "readable" as const,
    }));
  });
  beforeEach(async () => {
    await sql`DELETE FROM code.codes`;
    await sql`DELETE FROM code.database_deletions`;
    await sql`DELETE FROM audit.events`;
    days = 30;
    setSystemTime(fixed);
    removed.length = 0;
  });
  afterAll(async () => {
    settings?.mockRestore();
    retentionSetting?.mockRestore();
    connection?.mockRestore();
    setSystemTime();
    await db?.drop();
  });
  test("migration preserves a legacy namespace and admits only incarnations belonging to the same Code", async () => {
    const id = await fixture();
    await migrateCode();
    const [legacy] = await sql<{ namespace: string }[]>`SELECT namespace FROM code.databases WHERE code_id=${id}`;
    expect(legacy?.namespace).toBe(`code_${id}`);
    const namespace = `code_${id}_${"a".repeat(32)}`;
    await sql`UPDATE code.databases SET namespace=${namespace} WHERE code_id=${id}`;
    await migrateCode();
    const [incarnation] = await sql<{ namespace: string }[]>`SELECT namespace FROM code.databases WHERE code_id=${id}`;
    expect(incarnation?.namespace).toBe(namespace);
    await expect(
      sql`UPDATE code.databases SET namespace=${`code_c_other_${"a".repeat(32)}`} WHERE code_id=${id}`.execute(),
    ).rejects.toThrow();
  });
  test("deadline runs in the read model, survives migration and stops immediately on reactivation", async () => {
    const id = await fixture();
    const page = await listUnusedCodeDatabases(context);
    expect(page.items[0]).toMatchObject({ codeId: id, since: since.toISOString(), deleteAt: fixed.toISOString(), bytes: 4096 });
    await migrateCode();
    expect(await unused(id)).toEqual(since);
    await sql`UPDATE code.codes SET state='active' WHERE id=${id}`;
    expect(await unused(id)).toBeNull();
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    await sql`UPDATE code.codes SET state='paused' WHERE id=${id}`;
    expect(await unused(id)).not.toEqual(since);
  });
  test("latest or selected database declarations end the period; unrelated historical versions do not", async () => {
    const id = await fixture();
    const dbVersion = await version(id, 2, true);
    expect(await unused(id)).toBeNull();
    await sql`UPDATE code.codes SET active_version_id=${dbVersion}::uuid WHERE id=${id}`;
    await version(id, 3, false);
    expect(await unused(id)).toBeNull();
    await sql`UPDATE code.codes SET active_version_id=NULL WHERE id=${id}`;
    expect(await unused(id)).toBeInstanceOf(Date);
  });
  test("a waiting activation of a historical database version ends the deadline until cancelled", async () => {
    const id = await fixture();
    const rollback = await version(id, 2, true);
    await version(id, 3, false);
    await age(id);
    await sql`INSERT INTO code.activations(id,code_id,version_id,locale,cloud_admin,state)
      VALUES('33333333-3333-4333-8333-333333333333',${id},${rollback}::uuid,'en',TRUE,'waiting')`;
    expect(await unused(id)).toBeNull();
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    await sql`UPDATE code.activations SET state='cancelled' WHERE code_id=${id}`;
    expect(await unused(id)).toBeInstanceOf(Date);
  });
  test("activation completion never takes the Code lock after the activation lock", async () => {
    const id = await fixture();
    const rollback = await version(id, 2, true);
    await version(id, 3, false);
    await sql`INSERT INTO code.activations(id,code_id,version_id,locale,cloud_admin,state)
      VALUES('44444444-4444-4444-8444-444444444444',${id},${rollback}::uuid,'en',TRUE,'waiting')`;
    await sql.begin(async (codeLock) => {
      await codeLock`SELECT id FROM code.codes WHERE id=${id} FOR UPDATE`;
      await sql.begin(async (activation) => {
        await activation`SET LOCAL lock_timeout='100ms'`;
        await activation`UPDATE code.activations SET state='cancelled' WHERE code_id=${id}`;
      });
    });
    expect(await unused(id)).toBeInstanceOf(Date);
  });
  test("an unchanged database requirement does not wait behind provisioning's mapping lock", async () => {
    const id = await fixture();
    await sql`UPDATE code.codes SET state='active' WHERE id=${id}`;
    await sql.begin(async (provisioning) => {
      await provisioning`SELECT code_id FROM code.databases WHERE code_id=${id} FOR UPDATE`;
      await sql.begin(async (save) => {
        await save`SET LOCAL lock_timeout='100ms'`;
        await version(id, 2, false, save);
      });
    });
    expect(await unused(id)).toBeNull();
  });
  test("one locked mapping does not abort expiry for the next candidate", async () => {
    const busy = await fixture();
    const ready = await fixture();
    await sql.begin(async (mappingLock) => {
      await mappingLock`SELECT code_id FROM code.databases WHERE code_id=${busy} FOR UPDATE`;
      expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(1);
    });
    expect(await unused(busy)).toEqual(since);
    expect(await unused(ready)).toBeUndefined();
  });
  test("the remote worker refuses a namespace remapped by a legacy replica", async () => {
    const id = await fixture();
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(1);
    const [job] = await sql<
      { id: string; attempts: number; code_id: string; namespace: string; server_url: string }[]
    >`SELECT * FROM code.database_deletions`;
    await sql`UPDATE code.codes SET state='active' WHERE id=${id}`;
    await sql`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes,connected)
      VALUES(${id},${`code_${id}`},'http://rsql.test',104857600,TRUE)`;
    await expect(processDatabaseDeletion(job!, () => client)).rejects.toThrow("code_database_namespace_mapped");
    expect(removed).toEqual([]);
    expect(await sql`SELECT id FROM code.database_deletions`).toHaveLength(1);
    await sql`UPDATE code.codes SET state='paused' WHERE id=${id}`;
    await age(id);
    await expect(deleteUnusedCodeDatabase(await confirmation(id), context)).rejects.toMatchObject({ code: "CONFLICT" });
    const next = await fixture();
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(1);
    expect(await unused(id)).toEqual(since);
    expect(await unused(next)).toBeUndefined();
  });
  test("expiry commits deletion intent and audit, frees quota, retries and never targets the new active incarnation", async () => {
    const id = await fixture();
    expect(await codeDatabaseOwnerCapacity(sql, id)).toBe(104857600);
    expect(await expireUnusedCodeDatabases(new Date(fixed.getTime() - 1), signal())).toBe(0);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(1);
    expect(await codeDatabaseOwnerCapacity(sql, id)).toBe(0);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const [job] = await sql<
      { id: string; attempts: number; code_id: string; namespace: string; server_url: string }[]
    >`SELECT * FROM code.database_deletions`;
    expect(await sql`SELECT id FROM audit.events WHERE action='core.code.database.deletion_requested'`).toHaveLength(1);
    await sql`UPDATE code.codes SET state='active' WHERE id=${id}`;
    await sql`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes,connected) VALUES(${id},${`code_${id}_${"a".repeat(32)}`},'http://rsql.test',104857600,TRUE)`;
    await expect(
      processDatabaseDeletion(job!, () => ({
        ...client,
        remove: async () => {
          throw new Error("offline");
        },
      })),
    ).rejects.toThrow("code_database_deletion_retry");
    expect(await sql`SELECT id FROM code.database_deletions`).toHaveLength(1);
    await processDatabaseDeletion(job!, () => client);
    await processDatabaseDeletion(job!, () => client);
    expect(removed).toEqual([`code_${id}`]);
    expect(await codeDatabaseOwnerCapacity(sql, id)).toBe(104857600);
    expect(await sql`SELECT id FROM audit.events WHERE action='core.code.database.deleted'`).toHaveLength(1);
  });
  test("a concurrent activation wins before deletion and an old confirmation cannot delete after a new grace period", async () => {
    const id = await fixture();
    const old = await confirmation(id);
    await sql.begin(async (tx) => {
      await tx`UPDATE code.codes SET state='active' WHERE id=${id}`;
      expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    });
    await expect(deleteUnusedCodeDatabase(old, context)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE code.codes SET state='paused' WHERE id=${id}`;
    await expect(deleteUnusedCodeDatabase(old, context)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(deleteUnusedCodeDatabase(await confirmation(id), context)).resolves.toEqual({ deleted: true });
  });
  test("confirmed delete is idempotent, excludes readers, and zero disables only automatic deletion", async () => {
    const id = await fixture();
    const input = await confirmation(id);
    days = 0;
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const stranger = { ...user, id: "22222222-2222-4222-8222-222222222222", roles: [] };
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${stranger.id}::uuid,'reader','local','user') ON CONFLICT DO NOTHING`;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${stranger.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${id},${grant!.id}::uuid)`;
    await expect(
      deleteUnusedCodeDatabase(input, {
        authority: { ...context.authority, actor: { kind: "user", user: stranger }, accessSubject: { type: "user", userId: stranger.id } },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await deleteUnusedCodeDatabase(input, context)).toEqual({ deleted: true });
    expect(await deleteUnusedCodeDatabase(input, context)).toEqual({ deleted: true });
    expect(await sql`SELECT id FROM code.database_deletions`).toHaveLength(1);
  });
  test("admin deletion requires an admin-capable credential while owner editing keeps write scope", async () => {
    const id = await fixture();
    const input = await confirmation(id);
    const admin = { ...user, id: "55555555-5555-4555-8555-555555555555", uid: "other-admin" };
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin)
      VALUES(${admin.id}::uuid,'other-admin','local','user',TRUE) ON CONFLICT DO NOTHING`;
    const scoped: CodeContext = {
      authority: {
        actor: { kind: "user", user: admin },
        accessSubject: { type: "user", userId: admin.id },
        credentialKind: "oauth",
        scopes: ["write"],
      },
    };
    await expect(deleteUnusedCodeDatabase(input, scoped)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await unused(id)).toEqual(since);
    await expect(deleteUnusedCodeDatabase(input, { authority: { ...scoped.authority, scopes: ["admin"] } })).resolves.toEqual({
      deleted: true,
    });
    const owned = await fixture();
    await expect(
      deleteUnusedCodeDatabase(await confirmation(owned), {
        authority: { ...context.authority, credentialKind: "oauth", scopes: ["write"] },
      }),
    ).resolves.toEqual({ deleted: true });
  });
  test("an unreadable retention setting leaves Code usage readable and automatic deletion stopped", async () => {
    const id = await fixture();
    retentionSetting.mockResolvedValueOnce({ value: 30, stored: "unreadable" });
    const usage = await readCodeDatabaseUsage(id, () => client);
    expect(usage.state).toBe("ready");
    expect(usage.unused).toBeUndefined();
    retentionSetting.mockResolvedValueOnce({ value: 30, stored: "unreadable" });
    await expect(expireUnusedCodeDatabases(fixed, signal())).rejects.toThrow("code_database_retention_setting_unreadable");
    expect(await unused(id)).toEqual(since);
    await sql`UPDATE code.codes SET state='active' WHERE id=${id}`;
    const reads = retentionSetting.mock.calls.length;
    expect((await readCodeDatabaseUsage(id, () => client)).state).toBe("ready");
    expect(retentionSetting.mock.calls.length).toBe(reads);
  });
  test("a full batch of pending legacy removals cannot starve later expiry candidates", async () => {
    for (let i = 0; i < 50; i++) {
      const id = await fixture();
      await sql`INSERT INTO code.database_deletions(code_id,namespace,server_url) VALUES(${id},${`code_${id}`},'http://rsql.test')`;
    }
    const ready = await fixture();
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(1);
    expect(await unused(ready)).toBeUndefined();
    expect(await sql`SELECT code_id FROM code.databases`).toHaveLength(50);
  });
  test("queued event runs cannot starve later expiry or prevent fresh visible notice", async () => {
    for (let i = 0; i < 50; i++) {
      const id = await fixture();
      const [v] = await sql<{ id: string }[]>`SELECT id FROM code.versions WHERE code_id=${id}`;
      await sql`UPDATE code.codes SET active_version_id=${v!.id}::uuid WHERE id=${id}`;
      await sql`INSERT INTO code.runs(code_id,version_id,trigger,entrypoint,payload_bytes,calls_limit)
        VALUES(${id},${v!.id}::uuid,'event','onEvent',4,1)`;
    }
    const ready = await fixture();
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(1);
    expect(await unused(ready)).toBeUndefined();
    expect(await sql`SELECT code_id FROM code.databases`).toHaveLength(50);
    await changeDays(3);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const deleteAt = new Date(fixed.getTime() + DATABASE_EXPIRY_NOTICE_MS);
    const dates = await sql<{ unused_delete_at: Date; unused_shown_at: Date }[]>`
      SELECT unused_delete_at,unused_shown_at FROM code.databases`;
    expect(dates).toHaveLength(50);
    for (const date of dates) expect(date).toEqual({ unused_delete_at: deleteAt, unused_shown_at: fixed });
    await sql`DELETE FROM code.runs`;
    expect(await expireUnusedCodeDatabases(deleteAt, signal())).toBe(50);
    expect(await sql`SELECT code_id FROM code.databases`).toHaveLength(0);
  });
  test("shortening retention persists the same visible advance notice in Code and admin before expiry", async () => {
    const id = await fixture();
    await changeDays(3);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const deleteAt = new Date(fixed.getTime() + DATABASE_EXPIRY_NOTICE_MS);
    expect((await readCodeDatabaseUsage(id, () => client)).unused?.deleteAt).toBe(deleteAt.toISOString());
    expect((await listUnusedCodeDatabases(context)).items[0]?.deleteAt).toBe(deleteAt.toISOString());
    expect(await expireUnusedCodeDatabases(new Date(deleteAt.getTime() - 1), signal())).toBe(0);
    expect(await expireUnusedCodeDatabases(deleteAt, signal())).toBe(1);
  });
  test("re-enabling retention never reuses a deadline from before it was disabled", async () => {
    const id = await fixture();
    await changeDays(0);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    expect((await readDatabaseDeadline(id))?.deleteAt).toBeNull();
    await changeDays(30);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const deleteAt = new Date(fixed.getTime() + DATABASE_EXPIRY_NOTICE_MS);
    expect((await readDatabaseDeadline(id))?.deleteAt).toBe(deleteAt.toISOString());
    expect(await expireUnusedCodeDatabases(deleteAt, signal())).toBe(1);
  });
  test("an off/on cycle between sweeps and resetting to the default retain advance notice", async () => {
    const id = await fixture();
    await changeDays(0);
    // Remove is the existing settings reset path. No intervening read or sweep observes zero.
    await sql`DELETE FROM settings.entries WHERE key='core.code.database_unused_days'`;
    days = 30;
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const deleteAt = new Date(fixed.getTime() + DATABASE_EXPIRY_NOTICE_MS);
    expect((await readDatabaseDeadline(id))?.deleteAt).toBe(deleteAt.toISOString());
    expect(await expireUnusedCodeDatabases(deleteAt, signal())).toBe(1);
  });
  test("a setting change cannot commit across the expiry admission's policy lock", async () => {
    const id = await fixture();
    await sql.begin(async (admission) => {
      const [before] = await admission<
        { revision: string }[]
      >`SELECT revision::text FROM code.database_retention_policy WHERE singleton FOR SHARE`;
      await expect(
        sql.begin(async (writer) => {
          await writer`SET LOCAL lock_timeout='100ms'`;
          await writer`INSERT INTO settings.entries(key,value) VALUES('core.code.database_unused_days','3')
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
        }),
      ).rejects.toThrow();
      const [after] = await admission<{ revision: string }[]>`SELECT revision::text FROM code.database_retention_policy WHERE singleton`;
      expect(after?.revision).toBe(before?.revision);
    });
    await changeDays(3);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    expect((await readDatabaseDeadline(id))?.deleteAt).toBe(new Date(fixed.getTime() + DATABASE_EXPIRY_NOTICE_MS).toISOString());
  });
  test("resource and app owners receive the same persisted visible advance notice", async () => {
    await fixture("resource");
    await fixture("app");
    await changeDays(1);
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const deleteAt = new Date(fixed.getTime() + DATABASE_EXPIRY_NOTICE_MS);
    expect((await listUnusedCodeDatabases(context)).items.map((row) => row.deleteAt)).toEqual([
      deleteAt.toISOString(),
      deleteAt.toISOString(),
    ]);
    expect(await expireUnusedCodeDatabases(deleteAt, signal())).toBe(2);
  });
  test("migration never invents elapsed visibility for an old overdue database", async () => {
    const id = await fixture();
    await sql`UPDATE code.databases SET unused_shown_at=NULL,unused_delete_at=NULL,unused_policy_revision=NULL WHERE code_id=${id}`;
    await migrateCode();
    expect(await expireUnusedCodeDatabases(fixed, signal())).toBe(0);
    const deleteAt = new Date(fixed.getTime() + DATABASE_EXPIRY_NOTICE_MS);
    expect((await readDatabaseDeadline(id))?.deleteAt).toBe(deleteAt.toISOString());
    await sql`UPDATE code.codes SET state='active' WHERE id=${id}`;
    expect(await readDatabaseDeadline(id)).toBeUndefined();
    expect(await expireUnusedCodeDatabases(deleteAt, signal())).toBe(0);
  });
  test("the administrator list is keyset-paginated without losing or duplicating rows", async () => {
    for (let i = 0; i < 21; i++) await fixture();
    const first = await listUnusedCodeDatabases(context);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe(first.items.at(-1)!.codeId);
    const second = await listUnusedCodeDatabases(context, first.nextCursor!);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((row) => row.codeId)).size).toBe(21);
  });
  test("personal owner reminder starts seven days before deletion and sends once per unused period", async () => {
    const id = await fixture();
    await sql`UPDATE code.databases SET unused_since='2026-11-01T12:00:00.000123Z'::timestamptz, unused_delete_at='2026-12-01T12:00:00.000123Z'::timestamptz WHERE code_id=${id}`;
    const notices: unknown[] = [];
    const sender = {
      sendCodeDatabaseExpiry: async (notice: unknown) => {
        notices.push(notice);
      },
    };
    await notifyUnusedCodeDatabases(sender, new Date("2026-11-24T11:59:59.999Z"), signal());
    expect(notices).toHaveLength(0);
    await notifyUnusedCodeDatabases(sender, new Date("2026-11-24T12:00:00.001Z"), signal());
    await notifyUnusedCodeDatabases(sender, new Date("2026-11-25T12:00:00.000Z"), signal());
    expect(notices).toHaveLength(1);
  });
});
