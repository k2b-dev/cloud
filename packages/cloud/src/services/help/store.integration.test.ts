// HELP_TEST_DATABASE_URL must point to a disposable database.
// Set HELP_TEST_BM25=1 only with pg_textsearch installed and preloaded.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHeartbeat } from "../../_internal/heartbeat";
import { compileHelp } from "../../_internal/help";
import { createAiHelpTools } from "../../ai/capabilities";
import { prepareAiTools } from "../../ai/tools";
import { createHelpRoutes } from "../../api/help";
import { createMcpRoutes } from "../../api/mcp";
import type { AppRegistryEntry } from "../../contracts/registry";
import { defineHelp } from "../../server/help";
import { createHelpReader } from "./index";
import { cleanupHelp, hasHelpBm25, migrateHelp, queryHelp, registerHelp } from "./store";

const actor = {
  kind: "user" as const,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "help-test",
    provider: "local" as const,
    profile: "user" as const,
    displayName: "Help Test",
    mail: "help@example.test",
    givenname: "Help",
    sn: "Test",
    roles: ["user" as const],
    accountExpires: null,
    avatarHash: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  },
};

const url = process.env.HELP_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const source = (id: string, title: string, body: string) => `---\nid: ${id}\ntitle: ${title}\n---\n${body}`;
const corpus = (body = "Editors can update inventory records.") =>
  compileHelp({
    appId: "help-integration",
    basePath: "/app/inventory",
    definition: defineHelp({
      baseLocale: "en",
      documents: {
        en: [
          source("permissions", "Permissions", body),
          source("fallback", "English fallback", "A rare untranslated narwhal."),
          source("technical", "kit.ui.modal.dialog", "Open a dialog."),
          source("long", "Background", "Background context. ".repeat(5500)),
        ],
        de: [source("permissions", "Berechtigungen", "Benutzer dürfen Datensätze ändern. Formulare erstellen und bearbeiten.")],
      },
    }),
  });

suite("Postgres Help publication and retrieval", () => {
  let db: SQL;
  let published = corpus();
  let active: AppRegistryEntry[];
  const resetApp = () => {
    active = [
      {
        id: "help-integration",
        name: "Inventory",
        description: "",
        icon: "box",
        routes: [],
        baseUrl: "http://inventory",
        help: published.summary,
      },
    ];
  };
  const reader = (locale = "en") =>
    createHelpReader(locale, { db, listApps: async () => active, getApp: async (id) => active.find((a) => a.id === id) ?? null });
  beforeAll(async () => {
    db = new SQL(url!, { max: 5 });
    await migrateHelp(db);
    await migrateHelp(db);
    await registerHelp(published.corpus, db);
    resetApp();
  });
  afterAll(async () => {
    await db`DELETE FROM help.corpora WHERE app_id='help-integration'`;
    await db.close();
  });

  test("registers once under concurrent starts and keeps only small discovery data", async () => {
    await Promise.all(Array.from({ length: 8 }, () => registerHelp(published.corpus, db)));
    const [row] =
      await db`SELECT count(*)::int AS count FROM help.documents WHERE app_id='help-integration' AND manifest_hash=${published.corpus.manifestHash}`;
    expect(row.count).toBe(5);
    expect(Object.keys(published.summary).sort()).toEqual(["baseLocale", "manifestHash", "pageBase"]);
    expect((await reader().manifest("help-integration"))?.documents.length).toBe(4);
  });
  test("selects each locale before filtering and returns the actual fallback language", async () => {
    expect(await reader("de-CH").search({ query: "Formular bearbeiten" })).toMatchObject([{ documentId: "permissions", locale: "de" }]);
    expect(await reader("de-CH").search({ query: "Editors inventory" })).toEqual([]);
    expect(await reader("de-CH").read({ appId: "help-integration", documentId: "fallback" })).toMatchObject({ locale: "en" });
    expect((await reader("de-CH").manifest("help-integration"))?.documents.find((d) => d.id === "fallback")?.locale).toBe("en");
  });
  test("ranks exact technical identifiers and handles stemming, punctuation, and limits", async () => {
    expect((await reader().search({ query: "kit.ui.modal.dialog" }))[0]?.documentId).toBe("technical");
    expect((await reader().search({ query: "editor updates inventory" }))[0]?.documentId).toBe("permissions");
    expect(await reader().search({ query: "doesnotexist" })).toEqual([]);
    expect(await reader().search({ query: "" })).toEqual([]);
    expect(await reader().search({ query: "' & !!" })).toEqual([]);
    expect(await reader().search({ query: "inventory", appId: "absent" })).toEqual([]);
  });
  test("metadata listing does not fetch bodies and uses a stable cursor", async () => {
    const first = await reader().list();
    expect(first.length).toBe(4);
    expect(first.every((d) => !("markdown" in d))).toBe(true);
    expect(await reader().list("cloud://help/help-integration/technical")).toEqual([]);
    const rows = await queryHelp(
      [{ app_id: "help-integration", app_name: "Inventory", manifest_hash: published.corpus.manifestHash, locales: ["en"] }],
      {},
      db,
    );
    expect(rows.every((row) => !("markdown" in row))).toBe(true);
  });
  test("does not expose a replaced hash or stopped app", async () => {
    active[0]!.help = { ...published.summary, manifestHash: "missing" };
    expect(await reader().read({ appId: "help-integration", documentId: "permissions" })).toBeNull();
    active = [];
    expect(await reader().search({ query: "inventory" })).toEqual([]);
    resetApp();
  });
  test("rolls back incomplete publication", async () => {
    const broken = {
      ...published.corpus,
      manifestHash: "broken",
      documents: [published.corpus.documents[0]!, published.corpus.documents[0]!],
    };
    await expect(registerHelp(broken, db)).rejects.toThrow();
    const rows = await db`SELECT 1 FROM help.corpora WHERE app_id='help-integration' AND manifest_hash='broken'`;
    expect(rows.length).toBe(0);
  });
  test("large corpora exceed the old registry bound without dropping search text", async () => {
    const large = compileHelp({
      appId: "help-integration",
      definition: defineHelp({
        documents: Array.from({ length: 8 }, (_, i) => source(`large-${i}`, `Large ${i}`, "searchable inventory details. ".repeat(3500))),
      }),
    });
    expect(Buffer.byteLength(JSON.stringify(large.corpus))).toBeGreaterThan(512 * 1024);
    await registerHelp(large.corpus, db);
    expect(
      (
        await db`SELECT count(*)::int AS count FROM help.documents WHERE app_id='help-integration' AND manifest_hash=${large.corpus.manifestHash}`
      )[0].count,
    ).toBe(8);
  }, 20000);
  test("metadata larger than the app registry budget remains outside discovery", async () => {
    const large = compileHelp({
      appId: "help-integration",
      definition: defineHelp({
        documents: Array.from(
          { length: 120 },
          (_, i) => `---\nid: metadata-${i}\ntitle: Article ${i}\ndescription: ${"Detailed guidance ".repeat(50)}\n---\nBody`,
        ),
      }),
    });
    expect(Buffer.byteLength(JSON.stringify(large.corpus.documents))).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(large.summary))).toBeLessThan(256);
    await registerHelp(large.corpus, db);
    active[0]!.help = large.summary;
    try {
      expect((await reader().manifest("help-integration"))?.documents.length).toBe(120);
      const first = await reader().list();
      expect(first.length).toBe(101);
      const last = first[99]!;
      const second = await reader().list(`cloud://help/${last.appId}/${last.documentId}`);
      expect(second.length).toBe(20);
      expect(new Set([...first.slice(0, 100), ...second].map((row) => row.documentId)).size).toBe(120);
    } finally {
      resetApp();
    }
  }, 20000);
  test("renews before advertisement and repairs missing data through the existing heartbeat", async () => {
    await db`DELETE FROM help.corpora WHERE app_id='help-integration' AND manifest_hash=${published.corpus.manifestHash}`;
    let advertised = false;
    const heartbeat = createHeartbeat(
      "help-integration",
      {},
      {
        beforeWrite: () => registerHelp(published.corpus, db),
        registry: {
          upsert: async () => {
            expect(await reader().read({ appId: "help-integration", documentId: "permissions" })).not.toBeNull();
            advertised = true;
          },
          touch: async () => true,
          delete: async () => {},
        },
      },
    );
    try {
      await heartbeat.start();
      expect(advertised).toBe(true);
    } finally {
      await heartbeat.stop();
    }
  });
  test("cleans expired versions but protects renewed versions", async () => {
    const old = corpus("Old description");
    await registerHelp(old.corpus, db);
    await db`UPDATE help.corpora SET last_seen_at=now()-interval '1 day' WHERE app_id='help-integration' AND manifest_hash=${old.corpus.manifestHash}`;
    await cleanupHelp(db);
    expect((await db`SELECT 1 FROM help.corpora WHERE app_id='help-integration' AND manifest_hash=${old.corpus.manifestHash}`).length).toBe(
      0,
    );
    expect(await reader().read({ appId: "help-integration", documentId: "permissions" })).not.toBeNull();
    await Promise.all([registerHelp(published.corpus, db), cleanupHelp(db)]);
    expect(await reader().read({ appId: "help-integration", documentId: "permissions" })).not.toBeNull();
  });
  test("HTTP search and read use the same SQL locale selection", async () => {
    const routes = createHelpRoutes({ help: reader, authenticate: async (_c, next) => next() });
    const headers = { "x-cloud-locale": "de-CH" };
    const found = await (await routes.request("/help/v1/help-integration/search?q=Formular", { headers })).json();
    expect(found.ids).toEqual(["permissions"]);
    const doc = await (await routes.request("/help/v1/help-integration/documents/permissions", { headers })).json();
    expect(doc.locale).toBe("de");
    expect(doc.markdown).toContain("Datensätze");
  });
  test("AI Help tools search and read the real SQL store", async () => {
    const tools = prepareAiTools({ tools: createAiHelpTools(reader, "de-CH"), actor, conversationId: "help-test" }).tools;
    const search = tools[0],
      read = tools[1];
    if (!search || search.kind !== "server" || !read || read.kind !== "server") throw new Error("Missing Help tools");
    const context = {
      signal: AbortSignal.timeout(10000),
      requestApproval: async () => true,
      requestClientTool: async <T>() => undefined as T,
    };
    expect(await search.execute({ query: "Formular bearbeiten" }, context)).toMatchObject({
      documents: [{ documentId: "permissions", locale: "de" }],
    });
    expect(await read.execute({ appId: "help-integration", documentId: "permissions" }, context)).toMatchObject({
      document: { locale: "de", markdown: expect.stringContaining("Datensätze") },
    });
  });
  test("MCP search, resource listing and full reads share the SQL corpus", async () => {
    const routes = createMcpRoutes({
      help: reader,
      listApps: async () => active,
      getOperatorLocale: async () => "en",
      getAppUrl: async () => "cloud.example.test",
      limit: async (_c, next) => next(),
      authenticate: async (c, next) => {
        c.set("actor", actor);
        c.set("accessSubject", { type: "user", userId: actor.user.id });
        c.set("credentialKind", "oauth");
        await next();
      },
    });
    const rpc = async (method: string, params: unknown) => {
      const response = await routes.request("/mcp/v1", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          "x-cloud-locale": "de-CH",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await rpc("tools/call", { name: "cloud__help__search", arguments: { query: "Formular bearbeiten" } })).toMatchObject({
      result: { structuredContent: { documents: [{ documentId: "permissions", locale: "de" }] } },
    });
    const listed = await rpc("resources/list", {});
    expect(listed.result.resources.length).toBe(4);
    expect(await rpc("resources/read", { uri: "cloud://help/help-integration/long" })).toMatchObject({
      result: { contents: [{ text: published.corpus.documents.find((d) => d.id === "long")!.markdown }] },
    });
  });
  test("reports the installed optional backend and falls back when an index is absent", async () => {
    const enabled = await hasHelpBm25(db);
    expect(enabled).toBe(process.env.HELP_TEST_BM25 === "1");
    if (enabled) {
      await db`DROP INDEX help.help_bm25_german_idx`.simple();
      expect(await hasHelpBm25(db)).toBe(false);
      expect((await reader("de").search({ query: "Formulare" }))[0]?.documentId).toBe("permissions");
      await migrateHelp(db);
      expect(await hasHelpBm25(db)).toBe(true);
    }
  });
});
