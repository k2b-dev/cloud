import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { compileHelp } from "../_internal/help";
import { appSkillManifestHash, registerAppSkills, skill } from "../ai/app-skills";
import { defineHelp } from "../server/help";
import { APP_CATALOG_RETENTION_MS, cleanupAppCatalogs } from "./app-catalog-store";
import { migrateHelp, registerHelp } from "./help/store";

const epoch = Date.UTC(2030, 0, 1);
const source = skill({ markdown: "---\nname: inventory-counting\ndescription: Count inventory.\n---\nCount each item." });
const help = (appId: string) =>
  compileHelp({
    appId,
    definition: defineHelp({ baseLocale: "en", documents: { en: ["---\nid: counting\ntitle: Count inventory\n---\nCount each item."] } }),
  });

databaseSuite()("registry-owned app catalog retention", () => {
  let db: SQL;
  let disposable: Awaited<ReturnType<typeof createDisposableDatabase>>;
  beforeAll(async () => {
    disposable = await createDisposableDatabase("app_catalogs");
    db = new SQL(disposable.url, { max: 2 });
    await migrateHelp(db);
    // Catalog shape published in 0.55.0, with the additive retention column from Core's migration.
    await db`CREATE SCHEMA ai`.simple();
    await db`CREATE TABLE ai.app_skill_catalogs (
      app_id text NOT NULL, manifest_hash text NOT NULL, skills jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
      unregistered_at timestamptz, PRIMARY KEY (app_id, manifest_hash)
    )`.simple();
  });
  afterAll(async () => {
    await db?.close();
    await disposable?.drop();
  });

  test("live catalogs survive old timestamps, old publishers, and hour-long idle; removal waits a day and return cancels it", async () => {
    const ids = ["healthy", "removed", "returning", "legacy"];
    const manifest = appSkillManifestHash([source]);
    for (const id of ids) {
      await registerHelp(help(id).corpus, db);
      expect(await registerAppSkills(id, [source], manifest, db)).toBe(true);
    }
    // Simulate a quiet app far beyond the previous six-minute expiry.
    await db`UPDATE help.corpora SET last_seen_at=${new Date(epoch - APP_CATALOG_RETENTION_MS * 2)}`;
    await db`UPDATE ai.app_skill_catalogs SET last_seen_at=${new Date(epoch - APP_CATALOG_RETENTION_MS * 2)}`;
    expect(await cleanupAppCatalogs(ids, db, new Date(epoch))).toBeNull();
    expect(await cleanupAppCatalogs(ids, db, new Date(epoch + 60 * 60_000))).toBeNull();

    // These are the same renewal statements used by @k2b/cloud 0.55.0. They neither duplicate nor control retention.
    for (let round = 0; round < 60; round++) {
      await db`UPDATE help.corpora SET last_seen_at=clock_timestamp() WHERE app_id='legacy' RETURNING app_id`;
      await db`UPDATE ai.app_skill_catalogs SET last_seen_at=now() WHERE app_id='legacy' RETURNING app_id`;
    }
    for (const table of ["help.corpora", "ai.app_skill_catalogs"]) {
      expect(await db.unsafe<{ app_id: string }[]>(`SELECT app_id FROM ${table} ORDER BY app_id`)).toEqual(
        ids.toSorted().map((app_id) => ({ app_id })),
      );
    }
    const goneAt = epoch + 60 * 60_000;
    expect(await cleanupAppCatalogs(["healthy", "legacy"], db, new Date(goneAt))).toBe(goneAt + APP_CATALOG_RETENTION_MS);
    await cleanupAppCatalogs(["healthy", "legacy", "returning"], db, new Date(goneAt + APP_CATALOG_RETENTION_MS - 1));
    // Continued legacy writes cannot save an app that really left the registry.
    await db`UPDATE help.corpora SET last_seen_at=clock_timestamp() WHERE app_id='removed'`;
    await db`UPDATE ai.app_skill_catalogs SET last_seen_at=now() WHERE app_id='removed'`;
    expect(await cleanupAppCatalogs(["healthy", "legacy", "returning"], db, new Date(goneAt + APP_CATALOG_RETENTION_MS))).toBeNull();
    for (const table of ["help.corpora", "ai.app_skill_catalogs"]) {
      expect(await db.unsafe<{ app_id: string }[]>(`SELECT app_id FROM ${table} ORDER BY app_id`)).toEqual(
        ["healthy", "legacy", "returning"].map((app_id) => ({ app_id })),
      );
    }
    expect(await db`SELECT 1 FROM help.documents WHERE app_id='removed'`).toHaveLength(0);
  });
});
