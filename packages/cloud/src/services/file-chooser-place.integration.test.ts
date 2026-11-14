import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { createFileChooserPlaceService } from "./file-chooser-place";

const suite = databaseSuite();
suite("Core file chooser places", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let service: ReturnType<typeof createFileChooserPlaceService>;
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  beforeAll(async () => {
    disposable = await createDisposableDatabase("file_chooser_places");
    db = new SQL(disposable.url);
    await db`CREATE SCHEMA IF NOT EXISTS auth`.simple();
    await db`CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY, uid TEXT NOT NULL, provider TEXT NOT NULL, profile TEXT NOT NULL)`.simple();
    const { migrate } = await import("../../../core/src/migrate/core/file-chooser-places");
    await migrate(db);
    await migrate(db);
    await db`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${first}::uuid, ${first}, 'local', 'user'), (${second}::uuid, ${second}, 'local', 'user')`;
    service = createFileChooserPlaceService(db);
  });
  afterAll(async () => {
    if (db) {
      await db`DELETE FROM auth.users WHERE id IN (${first}::uuid, ${second}::uuid)`;
      await db.close();
      await disposable.drop();
    }
  });
  test("remembers one place per person, forgets it for This device, and cascades account deletion", async () => {
    expect(await service.get(first)).toBeNull();
    const scans = {
      appId: "filesv2",
      folders: [
        { id: "n:base:1", name: "Büro" },
        { id: "n:base:2", name: "Scanner-Ablage" },
      ],
    };
    await service.set(first, scans);
    expect(await service.get(first)).toEqual(scans);
    expect(await service.get(second)).toBeNull();
    // The last write wins.
    await service.set(first, { appId: "invoices", folders: [] });
    expect(await service.get(first)).toEqual({ appId: "invoices", folders: [] });
    await service.set(first, null);
    expect(await service.get(first)).toBeNull();
    // A row this release cannot read opens This device instead of failing the chooser.
    await db`INSERT INTO auth.file_chooser_places (user_id, app_id, folders) VALUES (${second}::uuid, 'drive', '[{"id": ""}]'::jsonb)`;
    expect(await service.get(second)).toBeNull();
    await service.set(second, scans);
    await db`DELETE FROM auth.users WHERE id = ${second}::uuid`;
    expect(await db`SELECT 1 FROM auth.file_chooser_places WHERE user_id = ${second}::uuid`).toHaveLength(0);
  });
});
