import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { SQL } from "bun";
import * as Y from "yjs";
import { createDisposableDatabase, databaseSuite } from "../../../scripts/fixtures/test-infra";
import { createNotesApp } from "./app";
import { migrate } from "./database";
import { limits } from "./limits";
import { NotesService } from "./service";
import { NotesStore } from "./store";

const FIXED = new Date("2026-10-30T12:00:00Z");
const origin = "https://notes.example.test";
const options = { origin, storageBytes: 1024 ** 3, maxConnections: 50, maxOpenPads: 10 };
const password = "fixture-only-operator-password";

databaseSuite()("Notes moderation and administrator sessions", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  let service: NotesService;
  let app: ReturnType<typeof createNotesApp>;
  let passwordHash: string;
  let links: { readId: string; editId: string };
  beforeAll(async () => {
    database = await createDisposableDatabase("notes_moderation");
    db = new SQL(database.url);
    await migrate(db);
    passwordHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 8192, timeCost: 1 });
  });
  beforeEach(async () => {
    setSystemTime(FIXED);
    service = new NotesService(new NotesStore(db, options.storageBytes), { ...options, adminPasswordHash: passwordHash });
    await service.start();
    app = createNotesApp(async () => true, service, { ...options, adminPasswordHash: passwordHash });
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getText("text").insert(0, "moderated content");
    links = await service.create(Y.encodeStateAsUpdate(doc), "192.0.2.1");
    doc.destroy();
  });
  afterEach(async () => {
    await service.stop();
    await db`TRUNCATE pads,admin_sessions CASCADE`;
  });
  afterAll(async () => {
    setSystemTime();
    await db.close();
    await database.drop();
  });
  const post = (path: string, body: unknown, cookie = "", csrf = "", requestOrigin = origin) =>
    app.request(`/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: requestOrigin, Cookie: cookie, "x-csrf-token": csrf },
      body: JSON.stringify(body),
    });
  const session = async () => {
    const challenge = await app.request("/api/admin/session");
    const csrf = (await challenge.json()).csrf;
    const preauth = challenge.headers.get("set-cookie")!.split(";")[0]!;
    const login = await post("admin/login", { password }, preauth, csrf);
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    return { cookie, csrf: (await login.json()).csrf, headers: login.headers.get("set-cookie")! };
  };
  const report = async (email?: string) => {
    const response = await post("reports", {
      linkId: links.readId,
      reason: "abuse",
      text: "Specific description of the reported content",
      confirmed: true,
      ...(email ? { email } : {}),
    });
    expect(response.status).toBe(201);
    return (await response.json()).number as string;
  };
  test("report intake validates consent and details, returns a number, and limits its own window", async () => {
    expect((await post("reports", { linkId: links.readId, reason: "abuse", text: "x", confirmed: true })).status).toBe(400);
    expect(
      (await post("reports", { linkId: links.readId, reason: "abuse", text: "A specific explanation", confirmed: false })).status,
    ).toBe(400);
    for (let i = 2; i < limits.reportPerHour; i++) await report();
    expect((await post("reports", {})).status).toBe(429);
    expect((await app.request("/api/admin/reports")).status).toBe(401);
  });
  test("login rotates sessions and requires Origin and a pre-login CSRF token", async () => {
    expect((await post("admin/login", { password })).status).toBe(403);
    const admin = await session();
    expect(admin.headers).toContain("Secure");
    expect(admin.headers).toContain("HttpOnly");
    expect(admin.headers).toContain("SameSite=Strict");
    expect(admin.headers).toContain("__Host-");
    const current = await app.request("/api/admin/session", { headers: { Cookie: admin.cookie } });
    expect(await current.json()).toMatchObject({ authenticated: true, csrf: admin.csrf });
    expect((await post("admin/logout", {}, admin.cookie, "wrong")).status).toBe(403);
    expect((await post("admin/logout", {}, admin.cookie, admin.csrf, "https://foreign.test")).status).toBe(403);
    expect((await post("admin/logout", {}, admin.cookie, admin.csrf)).status).toBe(204);
    expect((await app.request("/api/admin/status", { headers: { Cookie: admin.cookie } })).status).toBe(401);
  });
  test("failed administrator logins have a separate bounded window", async () => {
    const challenge = await app.request("/api/admin/session");
    const token = (await challenge.json()).csrf;
    const cookie = challenge.headers.get("set-cookie")!.split(";")[0]!;
    for (let i = 0; i < limits.loginPerQuarterHour; i++)
      expect((await post("admin/login", { password: "wrong-fixture" }, cookie, token)).status).toBe(401);
    expect((await post("admin/login", { password }, cookie, token)).status).toBe(429);
    await report();
  });
  test("expiry and password rotation invalidate all previous administrator sessions", async () => {
    const admin = await session();
    setSystemTime(new Date(FIXED.getTime() + 12 * 3600000));
    expect((await app.request("/api/admin/status", { headers: { Cookie: admin.cookie } })).status).toBe(401);
    setSystemTime(FIXED);
    const changed = createNotesApp(async () => true, service, {
      ...options,
      adminPasswordHash: await Bun.password.hash("different-fixture", { algorithm: "argon2id", memoryCost: 8192, timeCost: 1 }),
    });
    expect((await changed.request("/api/admin/status", { headers: { Cookie: admin.cookie } })).status).toBe(401);
    setSystemTime(new Date(FIXED.getTime() + 12 * 3600000));
    await service.tick(FIXED.getTime() + 12 * 3600000);
    const [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM admin_sessions`;
    expect(row!.count).toBe(0);
  });
  test("decision, audit and content removal commit together and close open sockets", async () => {
    const id = await report("fixture@example.test");
    const admin = await session();
    const connection = await service.admit(links.editId, "192.0.2.3");
    const closed: string[] = [];
    await service.attach(connection, {
      send() {},
      close(_code, reason) {
        closed.push(reason);
      },
      bufferedAmount: () => 0,
    });
    expect(
      (await post(`admin/reports/${id}/decision`, { action: "block", reason: "This content violates the rules" }, admin.cookie, "wrong"))
        .status,
    ).toBe(403);
    const decide = () =>
      post(`admin/reports/${id}/decision`, { action: "block", reason: "This content violates the rules" }, admin.cookie, admin.csrf);
    expect((await decide()).status).toBe(200);
    expect((await decide()).status).toBe(200);
    expect(closed).toContain("blocked");
    const [storageBefore] = await db`SELECT size_bytes::text FROM pads WHERE read_id=${links.readId}`;
    expect(Number(storageBefore.size_bytes)).toBe(256 + Buffer.byteLength("This content violates the rules"));
    expect(await service.store.pendingCleanup(50)).toEqual([]);
    expect((await app.request(`/api/pads/${links.readId}`)).status).toBe(451);
    await expect(service.admit(links.editId, "192.0.2.4")).rejects.toMatchObject({ code: "blocked" });
    const [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM moderation_log`;
    expect(row!.count).toBe(1);
    const response = await app.request("/api/admin/reports", { headers: { Cookie: admin.cookie } });
    expect((await response.json()).reports[0]).toMatchObject({ state: "decided", decision: "block", notification_state: "pending" });
    expect((await post(`admin/reports/${id}/notified`, {}, admin.cookie, admin.csrf)).status).toBe(204);
    const [notice] = await db<{ notification_state: string }[]>`SELECT notification_state FROM reports WHERE id=${id}`;
    expect(notice!.notification_state).toBe("sent");
    expect((await post(`admin/reports/${id}/notified`, {}, admin.cookie, admin.csrf)).status).toBe(204);
  });
  test("owner deletion and expiry are recorded without duplicate audit entries", async () => {
    await service.remove(links.editId);
    await service.remove(links.editId);
    const [row] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM moderation_log WHERE action='delete'`;
    expect(row!.count).toBe(1);
    expect((await app.request(`/api/pads/${links.readId}`)).status).toBe(410);
  });
  test("full storage still allows operator login and a keep decision", async () => {
    const id = await report();
    // Simulate the durable logical budget being exhausted by existing notes.
    await db`UPDATE pads SET size_bytes=${options.storageBytes} WHERE read_id=${links.readId}`;
    await service.store.auditStorage();
    expect((await service.store.status()).full).toBe(true);
    const admin = await session();
    expect(
      (
        await post(
          `admin/reports/${id}/decision`,
          { action: "keep", reason: "The content does not violate the rules" },
          admin.cookie,
          admin.csrf,
        )
      ).status,
    ).toBe(200);
    expect((await app.request("/api/admin/status", { headers: { Cookie: admin.cookie } })).status).toBe(200);
  });
  test("invalid pre-login tokens do not consume password attempts and expired sessions can log in again", async () => {
    const admin = await session();
    setSystemTime(new Date(FIXED.getTime() + 12 * 3600000));
    for (let i = 0; i < limits.loginPerQuarterHour + 1; i++)
      expect((await post("admin/login", { password }, admin.cookie, admin.csrf)).status).toBe(403);
    const challenge = await app.request("/api/admin/session", { headers: { Cookie: admin.cookie } });
    const current = await challenge.json();
    expect(current.authenticated).toBe(false);
    expect((await post("admin/login", { password }, challenge.headers.get("set-cookie")!.split(";")[0]!, current.csrf)).status).toBe(200);
  });
  test("a committed decision with a lost commit response invalidates cached content", async () => {
    const id = await report();
    const admin = await session();
    const connection = await service.admit(links.editId, "192.0.2.3");
    const closed: string[] = [];
    await service.attach(connection, {
      send() {},
      close(_code, reason) {
        closed.push(reason);
      },
      bufferedAmount: () => 0,
    });
    const transaction = service.store.transaction.bind(service.store);
    service.store.transaction = async (run) => {
      await transaction(run);
      throw new Error("fixture_commit_response_lost");
    };
    expect(
      (await post(`admin/reports/${id}/decision`, { action: "block", reason: "This content violates the rules" }, admin.cookie, admin.csrf))
        .status,
    ).toBe(500);
    service.store.transaction = transaction;
    expect(closed).toContain("resync_required");
    expect((await app.request(`/api/pads/${links.readId}`)).status).toBe(451);
  });
  test("disabled administration has no password fallback", async () => {
    const disabled = createNotesApp(async () => true, service, options);
    expect((await disabled.request("/api/admin/session")).status).toBe(404);
    expect((await disabled.request("/api/admin/reports")).status).toBe(404);
  });
});
