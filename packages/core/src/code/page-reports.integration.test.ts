import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@k2b/cloud";
import type { CodeCheckedVersionManifest, User } from "@k2b/cloud/contracts";
import { defaultRailPreferences } from "@k2b/cloud/contracts/rail-preferences";
import * as server from "@k2b/cloud/server";
import * as settingsMiddleware from "@k2b/cloud/server/middleware/settings";
import * as railSnapshot from "@k2b/cloud/services/rail-snapshot";
import * as adminStatus from "@k2b/cloud/ssr/admin-status";
import { countOpenCodePageReports } from "@k2b/cloud/ssr/code-page-reports-count";
import * as layoutHelp from "@k2b/cloud/ssr/help";
import * as panelConsent from "@k2b/cloud/ssr/panel-consent";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { createCodeAdminRoutes } from "../api/code-admin";
import { createCodePageRoutes } from "../api/code-pages";
import type { CoreNotificationSender } from "../notifications";
import type { CodeContext } from "./access";
import { createCodePageReportNotificationOutbox, expireCodePageReports, listCodePageReports, resolveCodePageReport } from "./page-reports";
import { codeRequestVersion } from "./requests";
import { codePageVersionValue } from "./route-security";

// Hosting renders the page through the SSR plugin, which must be in place before it loads.
const root = mkdtempSync(join(tmpdir(), "core-code-page-reports-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { createCodeHostingRoutes } = await import("./hosting");

const ownerId = "11111111-1111-4111-8111-111111111111";
const reporterId = "22222222-2222-4222-8222-222222222222";
const adminId = "33333333-3333-4333-8333-333333333333";
const codeId = "c_pagerep1";
const person = (id: string, name: string, admin = false): User => ({
  id,
  uid: name.split(" ")[0]!.toLowerCase(),
  roles: admin ? ["user", "admin"] : ["user"],
  provider: "local",
  profile: "user",
  givenname: name.split(" ")[0]!,
  sn: name.split(" ")[1]!,
  displayName: name,
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const lea = person(ownerId, "Lea Muster");
const jana = person(reporterId, "Jana Probe");
const ben = person(adminId, "Ben Admin", true);
const context = (user: User): CodeContext => ({
  authority: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id }, credentialKind: "session", scopes: [] },
  locale: "de",
});
const manifest: CodeCheckedVersionManifest = {
  version: 1,
  entry: "code.ts",
  entrypoints: [
    { kind: "route", entrypoint: "route:GET:/", route: { method: "GET", path: "/", public: false }, cron: null, file: "code.ts", line: 1 },
    {
      kind: "route",
      entrypoint: "route:GET:/open",
      route: { method: "GET", path: "/open", public: true, layout: "plain" },
      cron: null,
      file: "code.ts",
      line: 2,
    },
  ],
  permissions: [],
  ai: false,
  policyRows: ["public_routes"],
  hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
};
const tree = { version: 1, kind: "Page", title: "Lieferavise der Woche", children: [{ kind: "Text", text: "Montag: 3 Lieferungen" }] };

const spies: { mockRestore(): void }[] = [];
const notices: Parameters<CoreNotificationSender["sendCodePageReport"]>[0][] = [];
const outbox = createCodePageReportNotificationOutbox({
  sendCodePageReport: async (notice) => {
    notices.push(notice);
  },
});
let versionId = "";
let database: Awaited<ReturnType<typeof useMigratedDatabase>> | undefined;

/** The label's browser routes as a member of the given person, or as a visitor without a session. */
const labelRoutes = (user?: User) =>
  new Hono<server.AuthContext>()
    .use("*", async (c, next) => {
      if (user) {
        c.set("actor", { kind: "user", user });
        c.set("accessSubject", { type: "user", userId: user.id });
        c.set("credentialKind", "session");
      }
      await next();
    })
    .route("/api/code/pages", createCodePageRoutes());
const post = async (user: User | undefined, path: "provenance" | "report", body: Record<string, unknown>) => {
  const response = await labelRoutes(user).request(`/api/code/pages/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as { data?: Record<string, unknown>; code?: string } };
};
const page = (path: string) => ({ codeId, path, version: codePageVersionValue(codeId, versionId) });

databaseSuite()("Code page label card and page reports", () => {
  beforeAll(async () => {
    database = await useMigratedDatabase("core_code_page_reports");
    for (const user of [lea, jana, ben])
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin,display_name)
        VALUES(${user.id}::uuid,${user.uid},'local','user',${user.roles.includes("admin")},${user.displayName})`;
    await sql`INSERT INTO code.codes(id,owner_kind,owner_user_id,title,created_by)
      VALUES(${codeId},'person',${ownerId}::uuid,'Lieferavise der Woche',${ownerId}::uuid)`;
    const [version] = await sql<{ id: string }[]>`INSERT INTO code.versions
      (code_id,number,source_files,bundle,source_hash,bundle_hash,manifest,source_bytes,bundle_bytes,created_by)
      VALUES(${codeId},1,${JSON.stringify({ "code.ts": "export {}" })}::text::jsonb,'bundle',${"a".repeat(64)},${"c".repeat(64)},
        ${JSON.stringify(manifest)}::text::jsonb,9,6,${ownerId}::uuid) RETURNING id`;
    versionId = version!.id;
    await sql`UPDATE code.codes SET active_version_id=${versionId}::uuid,state='active' WHERE id=${codeId}`;
    await sql`INSERT INTO code.activations(id,code_id,version_id,activating_person,locale,cloud_admin,state,updated_at)
      VALUES(gen_random_uuid(),${codeId},${versionId}::uuid,${ownerId}::uuid,'de',false,'active','2026-11-10T08:00:00Z')`;
    await sql`INSERT INTO code.version_submissions(code_id,version_id,binding) VALUES(${codeId},${versionId}::uuid,'{}'::jsonb)`;
    await sql`INSERT INTO code.version_decisions(version_id,binding,approved,outcome,sole_admin,decided_by,decided_via,auth_epoch)
      VALUES(${versionId}::uuid,'{}'::jsonb,true,'approved',false,${adminId}::uuid,'session',0)`;
    // Valkey is not part of this suite: every request budget has room.
    spies.push(
      spyOn(server, "ratelimit").mockImplementation(({ id }) => ({
        id,
        check: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
        checkOrThrow: async () => ({ limited: false, remaining: 1, resetIn: 1 }),
      })),
      spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
      spyOn(layoutHelp, "preloadLayoutHelp").mockResolvedValue(null),
      spyOn(panelConsent, "preloadPanelConsent").mockResolvedValue(undefined),
      spyOn(adminStatus, "preloadAdminCodeApprovals").mockResolvedValue(undefined),
    );
  }, 180_000);
  afterAll(async () => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    await database?.drop();
  });

  test("the pill costs no statement of its own: the version statement already names the owner", async () => {
    const meter = await meterSql();
    try {
      let read: Awaited<ReturnType<typeof codeRequestVersion>> | undefined;
      const version = await meter.during(async () => {
        read = await codeRequestVersion(codeId);
      });
      expect(version).toHaveLength(1);
      expect(read?.owner).toEqual({ kind: "person", userId: ownerId, name: "Lea Muster" });
      // A whole public page, with its label, reads exactly the version statement, for a visitor and for a member.
      for (const user of [undefined, jana]) {
        const router = new Hono<server.AuthContext>()
          .use("*", async (c, next) => {
            c.set("runtime" as never, { apps: [{ id: "core", name: "Core", routes: ["/code"] }] } as never);
            c.set("settings" as never, { app: { name: "Möbel Beispiel Cloud" } } as never);
            if (user) {
              c.set("user", user);
              c.set("actor", { kind: "user", user });
              c.set("accessSubject", { type: "user", userId: user.id });
              c.set("credentialKind", "session");
            }
            await next();
          })
          .route("/", createCodeHostingRoutes({ version: codeRequestVersion, request: async () => ({ kind: "page", status: 200, tree }) }));
        let status = 0;
        const statements = await meter.during(async () => {
          status = (await router.request(`https://cloud.test/code/${codeId}/open`)).status;
        });
        expect(status).toBe(200);
        const codeStatements = statements.filter((statement) => /\bcode\.|auth\.users/.test(statement));
        console.log("SQL BUDGET Code page with label", user ? "member" : "visitor", statements.length, statements);
        expect(codeStatements).toHaveLength(1);
        expect(codeStatements[0]).toStartWith("SELECT v.manifest,c.active_version_id,c.owner_kind");
      }
    } finally {
      await meter.close();
    }
  });

  test("the card tells each viewer what the table in 3n allows, and nothing more", async () => {
    const visitor = await post(undefined, "provenance", page("/open"));
    expect(visitor).toEqual({
      status: 200,
      body: { data: { viewer: "visitor", owner: null, automation: null, gives: "nothing", report: null } },
    });
    // A member who may not see the automation learns who owns the page (F26), not the automation.
    expect(await post(jana, "provenance", page("/"))).toEqual({
      status: 200,
      body: {
        data: {
          viewer: "member",
          owner: { kind: "person", name: "Lea Muster" },
          automation: null,
          gives: "account",
          report: { reportedAt: null },
        },
      },
    });
    expect((await post(jana, "provenance", page("/open"))).body.data?.gives).toBe("nothing");
    // The owner and every Cloud admin may see the automation: its version, since when it runs, and who approved it.
    for (const reader of [lea, ben]) {
      const card = await post(reader, "provenance", page("/"));
      expect(card.status).toBe(200);
      expect(card.body.data).toMatchObject({
        viewer: "reader",
        owner: { kind: "person", name: "Lea Muster" },
        automation: {
          title: "Lieferavise der Woche",
          version: 1,
          activeSince: "2026-11-10T08:00:00.000Z",
          approvedBy: "Ben Admin",
          href: `/app/assistant/code/${codeId}`,
        },
      });
    }
    expect(await post(jana, "provenance", { ...page("/"), version: codePageVersionValue(codeId, adminId) })).toEqual({
      status: 409,
      body: { code: "code_page_changed" },
    });
    const missing = await post(jana, "provenance", { ...page("/"), codeId: "c_missing1" });
    expect(missing).toEqual({ status: 404, body: { code: "code_route_not_found" } });
  });

  test("a report is stored once, reaches the admins after commit, and the card shows it to the person", async () => {
    const key = crypto.randomUUID();
    const report = { ...page("/"), reason: "security", text: "Die Seite fragt nach meinem Passwort.", key };
    const first = await post(jana, "report", report);
    expect(first.status).toBe(200);
    const reportedAt = first.body.data?.reportedAt;
    expect(typeof reportedAt).toBe("string");
    // The same key after a lost answer, or another key while the report is open, files nothing twice.
    expect((await post(jana, "report", report)).body.data?.reportedAt).toBe(reportedAt);
    expect((await post(jana, "report", { ...report, key: crypto.randomUUID(), text: "Noch einmal." })).body.data?.reportedAt).toBe(
      reportedAt,
    );
    const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM code.page_reports WHERE code_id=${codeId}`;
    expect(count).toBe(1);
    expect(await post(undefined, "report", { ...report, path: "/open", key: crypto.randomUUID() })).toEqual({
      status: 403,
      body: { code: "code_report_members_only" },
    });
    expect((await post(jana, "provenance", page("/"))).body.data?.report).toEqual({ reportedAt });
    expect(await countOpenCodePageReports(250)).toBe(1);

    // One page of admins, then one notice per admin; the person who reported is not among them.
    await outbox.reconcile();
    await outbox.reconcile();
    expect(notices).toEqual([
      {
        kind: "reported",
        userId: adminId,
        locale: expect.any(String),
        key: expect.stringContaining(`:reported:${adminId}`),
        codeId,
        path: "/",
        title: "Lieferavise der Woche",
        reason: "security",
        by: "Jana Probe",
      },
    ]);
    const [{ pending }] = await sql<{ pending: number }[]>`SELECT count(*)::int AS pending FROM code.page_report_outbox`;
    expect(pending).toBe(0);
  });

  test("admins read and resolve reports; the person is told once, and may report again", async () => {
    await expect(listCodePageReports({ codeId }, context(jana))).rejects.toThrow();
    const listed = await listCodePageReports({ codeId }, context(ben));
    expect(listed.nextCursor).toBeNull();
    expect(listed.items).toEqual([
      expect.objectContaining({
        reporter: { id: reporterId, name: "Jana Probe" },
        path: "/",
        reason: "security",
        state: "open",
        resolvedAt: null,
      }),
    ]);
    const admin = new Hono<server.AuthContext>()
      .use("*", async (c, next) => {
        c.set("user", ben);
        c.set("actor", { kind: "user", user: ben });
        c.set("accessSubject", { type: "user", userId: ben.id });
        c.set("credentialKind", "session");
        await next();
      })
      .route("/api/code/admin", createCodeAdminRoutes());
    const call = (path: string, body: unknown) =>
      admin.request(`/api/code/admin/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const viaRoute = (await (await call("reports/list", { codeId })).json()) as { data: { items: { id: string }[] } };
    expect(viaRoute.data.items.map((item) => item.id)).toEqual(listed.items.map((item) => item.id));
    const reportId = listed.items[0]!.id;
    const resolved = await call("reports/resolve", { codeId, reportId });
    expect(resolved.status).toBe(200);
    const { data } = (await resolved.json()) as { data: { state: string; resolvedAt: string } };
    expect(data.state).toBe("resolved");
    // Resolving again changes nothing and tells nobody twice.
    expect(await resolveCodePageReport({ codeId, reportId }, context(ben))).toEqual({ state: "resolved", resolvedAt: data.resolvedAt });
    notices.splice(0);
    await outbox.reconcile();
    expect(notices).toEqual([
      { kind: "resolved", userId: reporterId, locale: expect.any(String), key: expect.stringContaining(":resolved:"), codeId, path: "/" },
    ]);
    expect(await countOpenCodePageReports(250)).toBe(0);
    expect((await listCodePageReports({ codeId, state: "resolved" }, context(ben))).items).toHaveLength(1);
    expect((await post(jana, "provenance", page("/"))).body.data?.report).toEqual({ reportedAt: null });
    expect((await post(jana, "report", { ...page("/"), reason: null, text: "Wieder da.", key: crypto.randomUUID() })).status).toBe(200);
    expect(await countOpenCodePageReports(250)).toBe(1);
  });

  test("resolved reports leave with the automation's history; open ones stay; the Code takes them all", async () => {
    const [{ resolved_at }] = await sql<{ resolved_at: Date }[]>`SELECT resolved_at FROM code.page_reports WHERE state='resolved'`;
    expect(await expireCodePageReports({ now: new Date(resolved_at.getTime() + 29 * 86_400_000), limit: 10 })).toBe(0);
    expect(await expireCodePageReports({ now: new Date(resolved_at.getTime() + 31 * 86_400_000), limit: 10 })).toBe(1);
    const states = await sql<{ state: string }[]>`SELECT state FROM code.page_reports WHERE code_id=${codeId}`;
    expect(states.map((row) => row.state)).toEqual(["open"]);
    await sql`DELETE FROM code.codes WHERE id=${codeId}`;
    const [{ left }] = await sql<{ left: number }[]>`SELECT count(*)::int AS left FROM code.page_reports`;
    expect(left).toBe(0);
  });
});
