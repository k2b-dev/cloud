import { afterAll, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { User } from "@k2b/cloud/contracts";
import { databaseSuite, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateAuth } from "../migrate/core/auth";
import { migrate as migrateCode } from "../migrate/core/code";
import type { CodeContext } from "./access";
import { readCodeDatabaseUsage, readCodeDetails } from "./database";
import { codeDatabaseOwnerCapacity, reserveCodeDatabaseCapacity } from "./database-budget";
import type { CodeDatabaseClient } from "./database-client";
import { exportCodeDatabase } from "./database-export";
import { codeDatabaseSettings } from "./database-settings";
import { CODE_SETTINGS, codeSettings } from "./settings";

const fixed = new Date("2026-11-11T12:00:00.000Z");
const ownerId = "11111111-1111-4111-8111-111111111111";
const readerId = "22222222-2222-4222-8222-222222222222";
const adminId = "33333333-3333-4333-8333-333333333333";
const context = (id: string): CodeContext => {
  const user: User = {
    id,
    uid: id,
    roles: id === adminId ? ["admin"] : [],
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
  return {
    authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: id }, credentialKind: "session", scopes: [] },
  };
};

databaseSuite()("Code database owner capacity and export", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  let settings: ReturnType<typeof spyOn<typeof codeSettings, "get">>;
  let configuration: ReturnType<typeof spyOn<typeof codeDatabaseSettings, "read">>;
  let ordinal = 0;
  const exported: string[] = [];
  let ownerLimit = 1048576000;
  const client: CodeDatabaseClient = {
    create: async () => {},
    configure: async () => {},
    execute: async () => [],
    size: async () => 4096,
    remove: async () => {},
    async export(namespace) {
      exported.push(namespace);
      return new Response(new Uint8Array(4096));
    },
  };
  async function code(state = "draft", databaseDeclared = false) {
    const id = `c_db${String(++ordinal).padStart(4, "0")}`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,state) VALUES(${id},'person',${ownerId}::uuid,'Database fixture',${state})`;
    if (databaseDeclared)
      await sql`INSERT INTO code.versions(code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes)
      VALUES(${id},1,'{}','fixture',${"a".repeat(64)},${"b".repeat(64)},'{"database":true}',0,7)`;
    return id;
  }
  async function mapping(id: string, bytes = 104857600) {
    await sql`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes,connected)
      VALUES(${id},${`code_${id}`},'http://rsql.test',${bytes},TRUE)`;
  }
  beforeAll(async () => {
    setSystemTime(fixed);
    database = await useFreshDatabase("core_code_database_capacity");
    await migrateAuth();
    await migrateCode();
    await migrateCode(); // Additive and restart-safe.
    for (const [id, name] of [
      [ownerId, "owner"],
      [readerId, "reader"],
      [adminId, "admin"],
    ])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,${name},'local','user',${id === adminId})`;
    settings = spyOn(codeSettings, "get").mockImplementation(async (key) =>
      key === "core.code.database_owner_bytes" ? ownerLimit : CODE_SETTINGS[key].default,
    );
    const values = {
      "core.code.rsql_url": "http://rsql.test",
      "core.code.rsql_api_token": "fixture-token",
      "core.code.rsql_allowed_targets": ["rsql.test"],
    };
    configuration = spyOn(codeDatabaseSettings, "read").mockImplementation(async <K extends keyof typeof values>(key: K) => ({
      value: values[key],
      stored: "readable" as const,
    }));
  });
  beforeEach(async () => {
    await sql`DELETE FROM code.codes`;
    exported.length = 0;
    ownerLimit = 1048576000;
  });
  afterAll(async () => {
    settings?.mockRestore();
    configuration?.mockRestore();
    setSystemTime();
    await database?.drop();
  });

  test("owner admission counts every existing database and permits only one concurrent reservation at the remaining capacity", async () => {
    const first = await code(),
      second = await code(),
      third = await code();
    await mapping(first, ownerLimit - 104857600);
    const reserve = (id: string) =>
      sql.begin(async (tx) => {
        const capacity = await reserveCodeDatabaseCapacity(tx, id, 104857600, ownerLimit, true);
        await tx`INSERT INTO code.databases(code_id,namespace,server_url,reserved_bytes) VALUES(${id},${`code_${id}`},'http://rsql.test',${capacity})`;
      });
    const results = await Promise.allSettled([reserve(second), reserve(third)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await codeDatabaseOwnerCapacity(sql, first)).toBe(ownerLimit);
    const missing = (await sql`SELECT code_id FROM code.databases WHERE code_id=${second}`).length ? third : second;
    await expect(reserve(missing)).rejects.toMatchObject({ code: "code_db_owner_full" });
    ownerLimit *= 2;
    await reserve(missing);
    expect((await readCodeDatabaseUsage(first, () => client)).owner?.limit).toBe(ownerLimit);
  });

  test("existing reservations survive lowered owner limits and legacy mappings remain writable", async () => {
    const id = await code();
    await mapping(id, 1073741824);
    ownerLimit = 1048576000;
    expect(await sql.begin((tx) => reserveCodeDatabaseCapacity(tx, id, 104857600, ownerLimit, true))).toBe(1073741824);
    ownerLimit = 1;
    expect(await sql.begin((tx) => reserveCodeDatabaseCapacity(tx, id, 104857600, ownerLimit, true))).toBe(1073741824);
    await sql`UPDATE code.databases SET reserved_bytes=104857600 WHERE code_id=${id}`;
    // A higher requested per-Code ceiling cannot take reads away from an existing database.
    expect(await sql.begin((tx) => reserveCodeDatabaseCapacity(tx, id, 1073741824, ownerLimit, false))).toBe(104857600);
    await expect(sql.begin((tx) => reserveCodeDatabaseCapacity(tx, id, 1073741824, ownerLimit, true))).rejects.toMatchObject({
      code: "code_db_owner_full",
    });
  });

  test("ordinary calls do not contend with an owner's in-flight capacity reservation", async () => {
    const id = await code();
    await mapping(id);
    const [owner] = await sql<
      { key: string }[]
    >`SELECT jsonb_build_array(owner_kind,owner_user_id,owner_type,owner_id,owner_app_id)::text AS key
      FROM code.codes WHERE id=${id}`;
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`core.code.database-owner:${owner!.key}`},0))`;
      await sql.begin(async (ordinary) => {
        await ordinary`SET LOCAL statement_timeout='1s'`;
        expect(await reserveCodeDatabaseCapacity(ordinary, id, 104857600, ownerLimit, true)).toBe(104857600);
      });
    });
  });

  test("owner and administrator export the same mapped snapshot, a shared reader cannot, and no export creates a database", async () => {
    const id = await code("active", true);
    await mapping(id);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${readerId}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO code.shares(code_id,access_id) VALUES(${id},${grant!.id}::uuid)`;
    for (const caller of [ownerId, adminId]) {
      const response = await exportCodeDatabase(id, context(caller), () => client);
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${id}.sqlite"`);
      expect((await response.arrayBuffer()).byteLength).toBe(4096);
    }
    await expect(exportCodeDatabase(id, context(readerId), () => client)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(exported).toEqual([`code_${id}`, `code_${id}`]);
    const reader = await readCodeDetails(id, context(readerId));
    expect(reader.code.database.owner).toBeUndefined();
    expect(reader.code.database.canExport).toBe(false);
    const empty = await code();
    await expect(exportCodeDatabase(empty, context(ownerId), () => client)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await sql`SELECT code_id FROM code.databases WHERE code_id=${empty}`).toHaveLength(0);
  });
});
