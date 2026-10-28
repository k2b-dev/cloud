import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "../../ai/migrate";
import { encryptValue } from "./crypto";
import { assertSettingVersions } from "./versions";

databaseSuite()("setting write versions", () => {
  beforeAll(migrateCloudAi);
  test("stale writes identify the key and editor and keep secret values write-only", async () => {
    const rollback = new Error("rollback setting versions fixture");
    await expect(
      sql.begin(async (db) => {
        const [editor] = await db<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
        VALUES(${crypto.randomUUID()},'local','user','Settings editor') RETURNING id`;
        if (!editor) throw new Error("Missing settings editor");
        for (const key of ["ai.global_instructions", "ai.firecrawl_api_key", "legacy.setting_versions_fixture"]) {
          const encrypted = await encryptValue("Current value");
          const [row] = await db<{ updated_at: Date }[]>`INSERT INTO settings.entries(key,value,updated_at,updated_by)
          VALUES(${key},${encrypted},'2026-10-16T12:00:00Z',${editor.id}::uuid)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by
          RETURNING updated_at`;
          await expect(assertSettingVersions({ [key]: null }, db)).rejects.toMatchObject({
            code: "conflict",
            key,
            changedBy: { id: editor.id, name: "Settings editor" },
            changedAt: "2026-10-16T12:00:00.000Z",
            current: key === "ai.global_instructions" ? "Current value" : "",
          });
          await expect(assertSettingVersions({ [key]: row?.updated_at.toISOString() ?? null }, db)).resolves.toBeUndefined();
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
