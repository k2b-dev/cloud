import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { SQL } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { connectionFixture, stubConnections } from "../runtime/connections.test-fixture";
import { createSecretMaintenance, createSecretOwner } from "./secret-owners";
import { decryptSecretBytes, encryptSecretBytes } from "./settings/crypto";

const A = "ab".repeat(32),
  B = "cd".repeat(32);
let snapshot: ReturnType<typeof stubConnections> | undefined;
beforeEach(() => setSystemTime(new Date("2030-01-02T00:01:00Z")));
afterEach(() => {
  snapshot?.mockRestore();
  setSystemTime();
});
const withTable = async (run: (db: SQL) => Promise<void>) => {
  const rollback = new Error("rollback secret owner fixture");
  await expect(
    sql.begin(async (db) => {
      await db`CREATE SCHEMA secret_rotation_fixture`;
      await db`CREATE TABLE secret_rotation_fixture.credentials (
      account uuid NOT NULL, name text NOT NULL, access text, password text,
      revision int NOT NULL DEFAULT 7, updated_at timestamptz NOT NULL DEFAULT '2030-01-02T00:00:00Z',
      expires_at timestamptz NOT NULL DEFAULT '2030-01-03T00:00:00Z', PRIMARY KEY(account,name)
    )`;
      await run(db);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
};
const declaration = (db: SQL) =>
  createSecretOwner({
    id: "credentials",
    table: "secret_rotation_fixture.credentials",
    primaryKey: ["account", "name"],
    columns: ["access", "password"],
    db,
  });
const account = "00000000-0000-4000-8000-000000000001";

databaseSuite()("PostgreSQL secret owners", () => {
  test("CAS protects concurrent user writes and redacted payloads, with native composite-key pagination", async () => {
    await withTable(async (db) => {
      const owner = declaration(db);
      await db`INSERT INTO secret_rotation_fixture.credentials(account,name,access,password) VALUES (${account}::uuid,'one','old','retained'),(${account}::uuid,'two','another',null)`;
      const [row] = await owner.scan(null, 1);
      expect(row?.key).toEqual([account, "one"]);
      expect((await owner.scan(row!.key, 1))[0]?.key).toEqual([account, "two"]);
      await db`UPDATE secret_rotation_fixture.credentials SET access='user write',revision=8 WHERE account=${account}::uuid AND name='one'`;
      expect(await owner.compareAndSwap(row!, { access: "rewrapped", password: "rewrapped" })).toBe(false);
      const [current] = await owner.scan(null, 1);
      await db`UPDATE secret_rotation_fixture.credentials SET access=null,password=null WHERE account=${account}::uuid AND name='one'`;
      expect(await owner.compareAndSwap(current!, { access: "rewrapped", password: "rewrapped" })).toBe(false);
      const [saved] = await db`SELECT access,password,revision FROM secret_rotation_fixture.credentials WHERE name='one'`;
      expect(saved).toMatchObject({ access: null, password: null, revision: 8 });
    });
  });

  test("automatic two-column rewrap preserves timestamps, revision, expiry and raw plaintext", async () => {
    await withTable(async (db) => {
      snapshot = stubConnections({ appSecret: { current: A } });
      const raw = ' { "n": 1.00 }\n',
        access = await encryptSecretBytes(raw),
        password = await encryptSecretBytes("raw-password");
      await db`INSERT INTO secret_rotation_fixture.credentials(account,name,access,password) VALUES (${account}::uuid,'one',${access},${password})`;
      const [before] = await db`SELECT revision,updated_at,expires_at FROM secret_rotation_fixture.credentials`;
      snapshot.mockReturnValue(connectionFixture({ appSecret: { current: B, previous: A } }));
      const maintenance = createSecretMaintenance([declaration(db)], Date.parse("2030-01-02T00:00:00Z"));
      try {
        await maintenance.tick();
        const [after] = await db`SELECT access,password,revision,updated_at,expires_at FROM secret_rotation_fixture.credentials`;
        expect(after).toMatchObject(before!);
        expect(await decryptSecretBytes(after!.access, B)).toBe(raw);
        expect(await decryptSecretBytes(after!.password, B)).toBe("raw-password");
        expect(maintenance.metadata().owners?.[0]).toMatchObject({ rows: 1, previousOnly: 0, unreadable: 0 });
      } finally {
        await maintenance.stop();
      }
    });
  });
});
