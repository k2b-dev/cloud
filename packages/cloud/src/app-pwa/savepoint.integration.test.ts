import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { databaseSuite, requireDatabaseUrl } from "../../../../scripts/fixtures/test-infra";
import { withAppPwaTransaction } from "./transaction";

const suite = databaseSuite();
let db: SQL;

suite("App-PWA savepoint recovery", () => {
  beforeAll(() => {
    db = new SQL(requireDatabaseUrl(), { max: 1 });
  });
  afterAll(async () => {
    await db?.close();
  });

  test("returned lazy query arrays execute inside the savepoint and roll back together", async () => {
    await withAppPwaTransaction(db, undefined, async (tx) => {
      await tx`CREATE TEMP TABLE app_pwa_array_guard(id integer PRIMARY KEY) ON COMMIT DROP`;
      const result = await tx.savepoint((nested) => [
        nested`INSERT INTO app_pwa_array_guard VALUES (1) RETURNING id`,
        nested`INSERT INTO app_pwa_array_guard VALUES (2) RETURNING id`,
      ]);
      expect(result).toEqual([[{ id: 1 }], [{ id: 2 }]]);
      await expect(
        tx.savepoint((nested) => [nested`INSERT INTO app_pwa_array_guard VALUES (3)`, nested`INSERT INTO app_pwa_array_guard VALUES (1)`]),
      ).rejects.toMatchObject({ errno: "23505" });
      const rows = await tx<{ id: number }[]>`SELECT id FROM app_pwa_array_guard ORDER BY id`;
      expect(rows.map((row) => row.id)).toEqual([1, 2]);
    });
  });

  test("a caught SQL constraint violation preserves its error and lets the outer transaction commit", async () => {
    const count = await withAppPwaTransaction(db, undefined, async (tx) => {
      await tx`CREATE TEMP TABLE app_pwa_savepoint_guard(id integer PRIMARY KEY) ON COMMIT DROP`;
      await tx`INSERT INTO app_pwa_savepoint_guard VALUES (1)`;
      await expect(
        tx.savepoint(async (nested) => {
          await nested`INSERT INTO app_pwa_savepoint_guard VALUES (1)`;
        }),
      ).rejects.toMatchObject({ errno: "23505" });
      await tx`INSERT INTO app_pwa_savepoint_guard VALUES (2)`;
      const rows = await tx<{ id: number }[]>`SELECT id FROM app_pwa_savepoint_guard ORDER BY id`;
      return rows.map((row) => row.id);
    });
    expect(count).toEqual([1, 2]);
    expect((await db<{ ready: number }[]>`SELECT 1 AS ready`)[0]?.ready).toBe(1);
  });
});
