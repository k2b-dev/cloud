import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createSync, type Sync } from "@k2b/sync";
import { sql } from "bun";
import { connectTestNats, suiteFor, testSyncNamespace, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { deleteTestNamespace } from "../../../../../scripts/fixtures/test-sync";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate as migrateLogging } from "../../../../core/src/migrate/core/logging";
import { buildSearchIndexes, migrate } from "../../../../core/src/migrate/core/outgoing-mail";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import * as registry from "../../_internal/registry";
import type { MailFilter, MailPageParams } from "../../contracts/outgoing-mail";
import { audit } from "../audit";
import { toPgTextArray } from "../postgres";
import { outgoingMailLog } from "./admin";
import { mail } from "./index";
import { outgoingMailStore } from "./store";

const context = { actor: { uid: "mail-log-test" }, requestId: crypto.randomUUID() };
const list = async (filter: MailFilter = {}, page: MailPageParams = {}) => {
  const result = await mail.list(filter, page);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};
const identity = (appId = "reader", read = true) => {
  clearProcessApplicationId();
  bindProcessApplicationId(appId, read ? ["mail:read"] : ["mail:send"]);
};
const insert = async (appId: string, subject = "Invoice", to = ["User@Example.org"], at = "2026-10-09T12:00:00Z") => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO outgoing_mail.messages(id, app_id, profile_key, lane, to_addresses, recipient_count,
    subject, text_body, html_body, headers, message_id_header, status, deadline_at, created_at)
    VALUES (${id}::uuid, ${appId}, 'sender', 'immediate', ${toPgTextArray(to)}::text[], ${to.length},
      ${subject}, 'private text', '<p>private html</p>', '{"x-private":"secret"}', ${id}, 'sent', now(), ${at}::timestamptz)`;
  return id;
};

suiteFor("database", "nats")("application mail log access and indexed search", () => {
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  let registered: ReturnType<typeof spyOn<typeof registry, "listApps">>;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let sync: Sync;
  let namespace: string;
  beforeAll(async () => {
    fresh = await useFreshDatabase("mail_log_access");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.simple();
    await migrate();
    await migrateAudit();
    await migrateLogging();
    // Core builds the search indexes after setup, under a NATS lease.
    connection = await connectTestNats({ ignoreClusterUpdates: true });
    namespace = testSyncNamespace("mail-log-access");
    sync = createSync({ connection, namespace, application: "core", defaults: { replicas: 1 } });
    bindProcessSync(sync);
    await sync.ready();
    expect(await buildSearchIndexes()).toBe("built");
    registered = spyOn(registry, "listApps").mockResolvedValue([
      {
        id: "reader",
        name: "Reader",
        icon: "mail",
        description: "Reader",
        routes: [],
        baseUrl: "http://test",
        platformPermissions: ["mail:read"],
      },
      {
        id: "core",
        name: "Core",
        icon: "mail",
        description: "Core",
        routes: [],
        baseUrl: "http://test",
        platformPermissions: ["mail:send", "mail:read"],
      },
    ]);
  });
  beforeEach(async () => {
    identity();
    await sql`TRUNCATE outgoing_mail.messages, outgoing_mail.app_log_access, audit.events`;
  });
  afterAll(async () => {
    clearProcessApplicationId();
    registered?.mockRestore();
    unbindProcessSync();
    await sync?.drain();
    if (namespace) await deleteTestNamespace(namespace);
    await connection?.drain();
    await sql.close();
    await fresh?.drop();
  });
  test("own-only defaults, explicit grants, metadata-only foreign rows and immediate revocation", async () => {
    const own = await insert("reader");
    const source = await insert("source");
    await insert("other");
    await insert("core");
    await outgoingMailStore.setAppLogAccess("reader", { apps: ["source"] }, context);
    expect((await list()).items.map((row) => row.id)).toEqual([own]);
    expect((await list()).items[0]?.text).toBe("private text");
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["reader", "source"] });
    expect((await list({ apps: ["source"] })).items.map((row) => row.id)).toEqual([source]);
    const all = await list({ apps: ["reader", "source"] });
    expect(all.total).toBe(2);
    expect(all.items.find((row) => row.id === source)).toMatchObject({ appId: "source", subject: "Invoice", to: ["User@Example.org"] });
    expect(all.items.find((row) => row.id === source)).not.toHaveProperty("text");
    expect(all.items.find((row) => row.id === own)?.text).toBe("private text");
    expect(JSON.stringify(all)).not.toContain("private html");
    expect(JSON.stringify(all)).not.toContain("x-private");
    expect(await mail.list({ apps: ["source", "other"] })).toMatchObject({ ok: false, error: { code: "app_not_allowed", status: 403 } });
    // Core's mail is never granted, so naming it is refused like any ungranted app.
    expect(await mail.list({ apps: ["core"] })).toMatchObject({ ok: false, error: { code: "app_not_allowed" } });
    identity("reader", false);
    expect(await mail.list({ apps: ["source"] })).toMatchObject({ ok: false, error: { code: "mail_not_declared", status: 403 } });
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["reader"] });
    identity();
    await outgoingMailStore.setAppLogAccess("reader", { apps: [] }, context);
    expect(await mail.list({ apps: ["source"] })).toMatchObject({ ok: false, error: { code: "app_not_allowed" } });
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["reader"] });
    expect((await list()).items.map((row) => row.id)).toEqual([own]);
    // Core reads only its own mail.
    identity("core");
    expect((await list()).items.map((row) => row.appId)).toEqual(["core"]);
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["core"] });
  });
  test("stored offline readers, sorted grants, validation and atomic audited replacement", async () => {
    const item = await outgoingMailStore.setAppLogAccess("offline", { apps: ["zebra", "alpha"] }, context);
    expect(item).toMatchObject({ appId: "offline", registered: false, declared: false, readDeclared: false, logApps: ["alpha", "zebra"] });
    expect((await outgoingMailStore.apps()).items).toContainEqual(item);
    expect((await outgoingMailStore.apps()).items.find((app) => app.appId === "reader")?.readDeclared).toBe(true);
    expect((await outgoingMailStore.apps()).items.find((app) => app.appId === "core")).toMatchObject({ readDeclared: false, logApps: [] });
    expect(await outgoingMailStore.logAppsFor("offline")).toEqual(["alpha", "zebra"]);
    identity("offline");
    expect(await mail.readableApps()).toEqual({ ok: true, data: ["offline", "alpha", "zebra"] });
    const events = await sql<{ action: string; target_type: string; target_id: string; apps: string }[]>`
      SELECT action, target_type, target_id, (metadata->'apps')::text AS apps FROM audit.events WHERE request_id = ${context.requestId}`;
    expect(events.map((event) => ({ ...event, apps: JSON.parse(event.apps) }))).toEqual([
      { action: "outgoing_mail.app_log_access.update", target_type: "outgoing_mail_app", target_id: "offline", apps: ["alpha", "zebra"] },
    ]);
    for (const [appId, apps] of [
      ["core", []],
      ["offline", ["offline"]],
      ["offline", ["core"]],
      ["", []],
      ["offline", ["a", "a"]],
    ] as const)
      await expect(outgoingMailStore.setAppLogAccess(appId, { apps: [...apps] }, context)).rejects.toMatchObject({
        code: "bad_input",
        status: 400,
      });
    expect(await sql`SELECT id FROM audit.events`).toHaveLength(1);
    const record = spyOn(audit, "record").mockRejectedValue(new Error("audit unavailable"));
    try {
      await expect(outgoingMailStore.setAppLogAccess("offline", { apps: ["replacement"] }, context)).rejects.toThrow("audit unavailable");
      expect(await outgoingMailStore.logAppsFor("offline")).toEqual(["alpha", "zebra"]);
    } finally {
      record.mockRestore();
    }
    expect(await outgoingMailStore.setAppLogAccess("offline", { apps: [] }, context)).toMatchObject({ logApps: [] });
    expect(await outgoingMailStore.logAppsFor("offline")).toEqual([]);
  });
  test("readableApps() at the grant limit and registry-style app IDs are valid filter.apps", async () => {
    const sources = Array.from({ length: 100 }, (_, i) => `source_${String(i).padStart(3, "0")}`);
    await outgoingMailStore.setAppLogAccess("erp_v2", { apps: sources }, context);
    identity("erp_v2");
    const own = await insert("erp_v2");
    const granted = await insert("source_099");
    const readable = await mail.readableApps();
    expect(readable).toEqual({ ok: true, data: ["erp_v2", ...sources] });
    if (!readable.ok) return;
    expect((await list({ apps: readable.data })).items.map((row) => row.id).sort()).toEqual([own, granted].sort());
    expect((await list({ apps: ["erp_v2"] })).items.map((row) => row.id)).toEqual([own]);
  });
  test("a search without a usable trigram is refused and every search is bounded in time", async () => {
    const timeout = async () => (await sql<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`)[0]?.timeout;
    const configured = await timeout();
    await insert("reader", "Discount ... week");
    expect(await mail.list({ q: "..." })).toMatchObject({ ok: false, error: { code: "bad_input", status: 400 } });
    expect(await mail.list({ q: "%_%" })).toMatchObject({ ok: false, error: { code: "bad_input", status: 400 } });
    // A search the database cannot answer within the budget stops and says so instead of running on.
    const holder = await sql.reserve();
    try {
      await holder`BEGIN`.simple();
      await holder`LOCK TABLE outgoing_mail.messages IN ACCESS EXCLUSIVE MODE`.simple();
      const started = performance.now();
      expect(await mail.list({ q: "discount" })).toMatchObject({
        ok: false,
        error: { code: "bad_input", status: 400, message: expect.stringContaining("took too long") },
      });
      expect(await mail.list({ recipient: "user@example.org" })).toMatchObject({ ok: false, error: { code: "bad_input" } });
      expect(performance.now() - started).toBeLessThan(15_000);
    } finally {
      await holder`ROLLBACK`.simple();
      holder.release();
    }
    // The limit belongs to the search's own transaction.
    expect((await list({ q: "discount" })).total).toBe(1);
    expect(await timeout()).toBe(configured);
  }, 30_000);
  test("q matches individual subject/recipient fields case-insensitively with literal wildcards", async () => {
    const subject = await insert("reader", "Monthly INVOICE", ["other@example.net"]);
    const recipient = await insert("reader", "Other", ["Invoice@Example.net", "second@example.net"]);
    const wildcard = await insert("reader", "Discount 50%_off \\sale", ["offer@example.net"]);
    await insert("reader", "Discount 50XXoff Xsale", ["offer@example.net"]);
    await insert("source", "invoice", ["invoice@example.net"]);
    expect((await list({ q: " InVoIcE " })).items.map((row) => row.id).sort()).toEqual([subject, recipient].sort());
    expect((await list({ q: "50%_off" })).items.map((row) => row.id)).toEqual([wildcard]);
    expect((await list({ q: "\\sale" })).items.map((row) => row.id)).toEqual([wildcard]);
    expect((await list({ q: "ond@EXAMPLE" })).items.map((row) => row.id)).toEqual([recipient]);
    expect((await list({ q: "OtherInvoice" })).total).toBe(0);
  });
  test("app recipient is exact and case-insensitive; admin recipient remains a substring with no content", async () => {
    const exact = await insert("reader", "Hello", ["USER@example.org"]);
    await insert("reader", "Hello", ["prefixuser@example.org"]);
    await insert("source", "Hello", ["user@example.org"]);
    expect((await list({ recipient: "user@EXAMPLE.org" })).items.map((row) => row.id)).toEqual([exact]);
    const admin = await outgoingMailLog.list({ app: "reader", recipient: "user@EXAMPLE.org" }, {});
    expect(admin.total).toBe(2);
    expect(admin.items.every((row) => !("text" in row))).toBe(true);
  });
  test("until is exclusive and combines with since", async () => {
    await insert("reader", "Before", undefined, "2026-10-09T10:00:00Z");
    const lower = await insert("reader", "At since", undefined, "2026-10-09T11:00:00Z");
    const middle = await insert("reader", "Within", undefined, "2026-10-09T11:30:00Z");
    await insert("reader", "At until", undefined, "2026-10-09T12:00:00Z");
    expect((await list({ until: "2026-10-09T12:00:00Z" })).total).toBe(3);
    expect((await list({ since: "2026-10-09T11:00:00Z", until: "2026-10-09T12:00:00Z" })).items.map((row) => row.id)).toEqual([
      middle,
      lower,
    ]);
  });
  test("filtered keyset pages return every matching row exactly once, including timestamp ties", async () => {
    await outgoingMailStore.setAppLogAccess("reader", { apps: ["source"] }, context);
    const expected: string[] = [];
    for (let i = 0; i < 23; i++) {
      const at = i < 12 ? "2026-10-09T11:00:00Z" : "2026-10-09T11:30:00Z";
      expected.push(await insert(i % 2 ? "reader" : "source", "MATCH invoice", ["User@example.org"], at));
      await insert("reader", "Does not match", ["other@example.org"], at);
      await insert("ungranted", "MATCH invoice", ["User@example.org"], at);
    }
    await insert("reader", "MATCH invoice", ["User@example.org"], "2026-10-09T12:00:00Z");
    const filter: MailFilter = {
      apps: ["reader", "source"],
      q: "invoice",
      recipient: "user@example.org",
      since: "2026-10-09T11:00:00Z",
      until: "2026-10-09T12:00:00Z",
      status: ["sent"],
    };
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await list(filter, { cursor, perPage: 4 });
      expect(result.page).toBe(page);
      expect(result.total).toBe(expected.length);
      seen.push(...result.items.map((row) => row.id));
      if (!result.hasNext) break;
      expect(result.nextCursor).toBeDefined();
      cursor = result.nextCursor;
    }
    expect(seen.sort()).toEqual(expected.sort());
    expect(new Set(seen).size).toBe(expected.length);
  });
  test("scoped selective searches use GIN indexes at realistic volume within the query budget", async () => {
    await sql`INSERT INTO outgoing_mail.messages(id, app_id, profile_key, lane, to_addresses, recipient_count,
      subject, message_id_header, status, deadline_at, created_at)
      SELECT gen_random_uuid(), 'app-' || (g % 6), 'sender', 'immediate',
        ARRAY[CASE WHEN g % 1500 = 0 THEN 'Unique@Example.org' ELSE 'recipient-' || g || '@example.org' END], 1,
        CASE WHEN g % 1000 = 0 THEN 'RareNeedle invoice ' || g ELSE 'Monthly invoice ' || g END,
        'volume-' || g, 'sent', now(), now() - (g || ' seconds')::interval
      FROM generate_series(1, 60000) AS g`;
    await sql`ANALYZE outgoing_mail.messages`.simple();
    const apps = ["app-0", "app-1", "app-2"];
    const predicates = [
      sql`outgoing_mail.search_text(subject, to_addresses) ILIKE '%rareneedle%'`,
      sql`outgoing_mail.lower_addresses(to_addresses) @> ARRAY[pg_catalog.lower('unique@example.org')]`,
    ];
    for (const [i, predicate] of predicates.entries()) {
      const index = i === 0 ? "outgoing_mail_messages_search" : "outgoing_mail_messages_recipients";
      for (const projection of [sql`id`, sql`count(*)`]) {
        const plan = await sql`EXPLAIN (FORMAT JSON) SELECT ${projection} FROM outgoing_mail.messages
          WHERE app_id = ANY(${toPgTextArray(apps)}::text[]) AND ${predicate}`;
        const encoded = JSON.stringify(plan);
        expect(encoded).toContain(index);
        expect(encoded).not.toContain('"Seq Scan"');
      }
      const plan = await sql`EXPLAIN (FORMAT JSON) SELECT id FROM outgoing_mail.messages
        WHERE app_id = ANY(${toPgTextArray(apps)}::text[]) AND ${predicate}
        ORDER BY created_at DESC, id LIMIT 51`;
      expect(JSON.stringify(plan)).toContain(index);
      expect(JSON.stringify(plan)).not.toContain('"Seq Scan"');
    }
    identity("app-0");
    await outgoingMailStore.setAppLogAccess("app-0", { apps: ["app-1", "app-2"] }, context);
    const start = performance.now();
    expect((await list({ apps, q: "rareneedle" })).total).toBe(40);
    expect((await list({ apps, recipient: "UNIQUE@example.org" })).total).toBe(40);
    expect(performance.now() - start).toBeLessThan(10000);
  }, 30000);
});
