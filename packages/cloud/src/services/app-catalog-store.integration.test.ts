import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDisposableDatabase, databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { createCatalogPublication } from "../_internal/catalog-publication";
import { compileHelp } from "../_internal/help";
import { appSkillManifestHash, registerAppSkills, skill } from "../ai/app-skills";
import { defineHelp } from "../server/help";
import { APP_CATALOG_RETENTION_MS, appCatalogExists, cleanupAppCatalogs } from "./app-catalog-store";
import { migrateHelp, registerHelp } from "./help/store";

const epoch = Date.UTC(2030, 0, 1);
const source = skill({ markdown: "---\nname: inventory-counting\ndescription: Count inventory.\n---\nCount each item." });
const help = (appId: string, body = "Count each item.") =>
  compileHelp({
    appId,
    definition: defineHelp({
      baseLocale: "en",
      documents: {
        en: [`---\nid: counting\ntitle: Count inventory\n---\n${body}`],
        de: ["---\nid: counting\ntitle: Bestand zählen\n---\nJedes Stück zählen."],
      },
    }),
  });

const registration = (id: string, publishedHelp = help(id), skills = [source]) => ({
  id,
  help: publishedHelp.summary,
  skills: { manifestHash: appSkillManifestHash(skills) },
});
const registrations = (ids: string[]) => ids.map((id) => registration(id));

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
  beforeEach(async () => {
    await db`TRUNCATE help.corpora CASCADE`.simple();
    await db`TRUNCATE ai.app_skill_catalogs`.simple();
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
    expect(await cleanupAppCatalogs(registrations(ids), db, new Date(epoch))).toBeNull();
    expect(await cleanupAppCatalogs(registrations(ids), db, new Date(epoch + 60 * 60_000))).toBeNull();

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
    expect(await cleanupAppCatalogs(registrations(["healthy", "legacy"]), db, new Date(goneAt))).toBe(goneAt + APP_CATALOG_RETENTION_MS);
    await cleanupAppCatalogs(registrations(["healthy", "legacy", "returning"]), db, new Date(goneAt + APP_CATALOG_RETENTION_MS - 1));
    // Continued legacy writes cannot save an app that really left the registry.
    await db`UPDATE help.corpora SET last_seen_at=clock_timestamp() WHERE app_id='removed'`;
    await db`UPDATE ai.app_skill_catalogs SET last_seen_at=now() WHERE app_id='removed'`;
    expect(
      await cleanupAppCatalogs(registrations(["healthy", "legacy", "returning"]), db, new Date(goneAt + APP_CATALOG_RETENTION_MS)),
    ).toBeNull();
    for (const table of ["help.corpora", "ai.app_skill_catalogs"]) {
      expect(await db.unsafe<{ app_id: string }[]>(`SELECT app_id FROM ${table} ORDER BY app_id`)).toEqual(
        ["healthy", "legacy", "returning"].map((app_id) => ({ app_id })),
      );
    }
    expect(await db`SELECT 1 FROM help.documents WHERE app_id='removed'`).toHaveLength(0);
  });
  test("a live app's old hashes expire after one day, including every localized Help article", async () => {
    const old = help("versions");
    const next = help("versions", "Count each item twice.");
    const changed = skill({ markdown: "---\nname: inventory-counting\ndescription: Count inventory.\n---\nCount twice." });
    await registerHelp(old.corpus, db);
    await registerHelp(next.corpus, db);
    await registerAppSkills("versions", [source], appSkillManifestHash([source]), db);
    await registerAppSkills("versions", [changed], appSkillManifestHash([changed]), db);
    const live = [registration("versions", next, [changed])];
    expect(await cleanupAppCatalogs(live, db, new Date(epoch))).toBe(epoch + APP_CATALOG_RETENTION_MS);
    await cleanupAppCatalogs(live, db, new Date(epoch + APP_CATALOG_RETENTION_MS - 1));
    expect(await appCatalogExists("help.corpora", "versions", old.corpus.manifestHash, db)).toBe(true);
    expect(await cleanupAppCatalogs(live, db, new Date(epoch + APP_CATALOG_RETENTION_MS))).toBeNull();
    expect(await appCatalogExists("help.corpora", "versions", old.corpus.manifestHash, db)).toBe(false);
    expect(await appCatalogExists("ai.app_skill_catalogs", "versions", appSkillManifestHash([source]), db)).toBe(false);
    expect(await appCatalogExists("help.corpora", "versions", next.corpus.manifestHash, db)).toBe(true);
    expect(await appCatalogExists("ai.app_skill_catalogs", "versions", appSkillManifestHash([changed]), db)).toBe(true);
    expect(await db`SELECT 1 FROM help.documents WHERE manifest_hash=${old.corpus.manifestHash}`).toHaveLength(0);
    expect(await db`SELECT 1 FROM help.documents WHERE manifest_hash=${next.corpus.manifestHash}`).toHaveLength(2);
  });

  test("publication cancels removal before Core observes the returning registration at the day boundary", async () => {
    const corpus = help("boundary");
    const hash = appSkillManifestHash([source]);
    await registerHelp(corpus.corpus, db);
    await registerAppSkills("boundary", [source], hash, db);
    await cleanupAppCatalogs([], db, new Date(epoch));
    // Startup returns just before the deadline. Core still has the preceding, empty registry snapshot.
    await registerHelp(corpus.corpus, db);
    await registerAppSkills("boundary", [source], hash, db);
    for (const table of ["help.corpora", "ai.app_skill_catalogs"] as const) {
      expect(await db.unsafe<{ unregistered_at: Date | null }[]>(`SELECT unregistered_at FROM ${table}`)).toEqual([
        { unregistered_at: null },
      ]);
    }
    await cleanupAppCatalogs([], db, new Date(epoch + APP_CATALOG_RETENTION_MS));
    expect(await appCatalogExists("help.corpora", "boundary", corpus.corpus.manifestHash, db)).toBe(true);
    expect(await appCatalogExists("ai.app_skill_catalogs", "boundary", hash, db)).toBe(true);
    await cleanupAppCatalogs([registration("boundary")], db, new Date(epoch + APP_CATALOG_RETENTION_MS));
    for (const table of ["help.corpora", "ai.app_skill_catalogs"] as const) {
      expect(await db.unsafe<{ unregistered_at: Date | null }[]>(`SELECT unregistered_at FROM ${table}`)).toEqual([
        { unregistered_at: null },
      ]);
    }
  });

  test("active publishers repair missing rows and older Core schemas without periodic writes", async () => {
    const corpus = help("repair");
    const hash = appSkillManifestHash([source]);
    const publishHelp = createCatalogPublication();
    const publishSkills = createCatalogPublication();
    let writes = 0;
    let warnings = 0;
    const onMissing = () => {
      warnings++;
    };
    const heartbeat = async () => {
      await publishHelp(
        corpus.corpus.manifestHash,
        async () => {
          writes++;
          await registerHelp(corpus.corpus, db);
        },
        {
          verify: () => appCatalogExists("help.corpora", "repair", corpus.corpus.manifestHash, db),
          onMissing,
        },
      );
      await publishSkills(
        hash,
        async () => {
          writes++;
          return registerAppSkills("repair", [source], hash, db);
        },
        {
          verify: () => appCatalogExists("ai.app_skill_catalogs", "repair", hash, db),
          onMissing,
        },
      );
    };
    await heartbeat();
    for (let round = 0; round < 60; round++) await heartbeat();
    expect(writes).toBe(2);
    // A restore or manual deletion loses the source rows while the process's successful hash cache remains.
    await db`DELETE FROM help.corpora`;
    await db`DELETE FROM ai.app_skill_catalogs`;
    await heartbeat();
    expect(writes).toBe(4);
    expect(warnings).toBe(2);
    await heartbeat();
    expect(writes).toBe(4);
    expect(await db`SELECT 1 FROM help.documents`).toHaveLength(2);
    // During an unsupported Core-first upgrade inversion, older Core's expiry can delete sources again.
    await db`ALTER TABLE help.corpora DROP COLUMN unregistered_at`.simple();
    await db`ALTER TABLE ai.app_skill_catalogs DROP COLUMN unregistered_at`.simple();
    try {
      await db`DELETE FROM help.corpora`;
      await db`DELETE FROM ai.app_skill_catalogs`;
      await heartbeat();
      expect(writes).toBe(6);
      expect(warnings).toBe(4);
      expect(await appCatalogExists("help.corpora", "repair", corpus.corpus.manifestHash, db)).toBe(true);
      expect(await appCatalogExists("ai.app_skill_catalogs", "repair", hash, db)).toBe(true);
    } finally {
      await db`ALTER TABLE help.corpora ADD COLUMN unregistered_at timestamptz`.simple();
      await db`ALTER TABLE ai.app_skill_catalogs ADD COLUMN unregistered_at timestamptz`.simple();
    }
  });
});
