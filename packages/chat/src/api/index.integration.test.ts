import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudRuntime } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { createConfig } from "@k2b/ssr";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { migrate } from "../migrate";
import { ChatHealthSchema, chatService } from "../service";
import chatApi from ".";

const root = mkdtempSync(join(tmpdir(), "chat-api-integration-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { adminPages } = await import("../frontend");

// rateLimit() in front of every chat API route reads its limit from settings and counts in Valkey.
const suite = suiteFor("database", "nats", "valkey");
setDefaultTimeout(30_000);

const origin = "https://cloud.example.test";
const server = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: [] });
    await next();
  })
  .route("/api/chat", chatApi)
  .route("/admin/chat", adminPages);
const request = (path: string, headers: Record<string, string> = {}) =>
  server.request(`${origin}${path}`, { headers: { "x-forwarded-for": uniqueCallerAddress(), ...headers } });

suite("chat skeleton", () => {
  const accountIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    // Setup runs on every start; a second run must change nothing.
    await migrate();
    await migrate();
  });

  afterAll(async () => {
    for (const id of accountIds) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
    for (const id of userIds) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
  });

  test("reports a healthy database once the chat schema exists", async () => {
    const health = await chatService.health();
    expect(health.status).toBe("ok");
    expect(health.database.status).toBe("ok");
    expect(health.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(health.observedAt))).toBeFalse();
  });

  test("keeps the health endpoint for administrators", async () => {
    expect((await request("/api/chat/admin/health")).status).toBe(401);

    const [account] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`Chat test ${crypto.randomUUID().slice(0, 8)}`}, 'standalone') RETURNING id`;
    accountIds.push(account!.id);
    const created = await serviceAccountCredentials.createApiToken({
      serviceAccountId: account!.id,
      name: "chat test",
      scopes: ["openid", "read"],
    });
    if (!created.ok) throw new Error(created.error.message);
    const response = await request("/api/chat/admin/health", { authorization: `Bearer ${created.data.token}` });
    expect(response.status).toBe(403);
  });

  test("shows an administrator the health snapshot through the API and on the admin page in both languages", async () => {
    const [admin] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`chat-admin-${crypto.randomUUID()}`}, 'local', 'user', 'Chat Admin', true) RETURNING id`;
    userIds.push(admin!.id);
    const cookie = `session_token=${await createTestSession(admin!.id)}`;

    const response = await request("/api/chat/admin/health", { cookie });
    expect(response.status).toBe(200);
    const health = ChatHealthSchema.parse(await response.json());
    expect(health).toMatchObject({ status: "ok", database: { status: "ok" } });

    const english = await request("/admin/chat", { cookie, "accept-language": "en" });
    expect(english.status).toBe(200);
    const englishHtml = await english.text();
    expect(englishHtml).toContain("Operations");
    expect(englishHtml).toContain("Healthy");
    expect(englishHtml).toContain("Checked at");

    const german = await request("/admin/chat", { cookie, "accept-language": "de-DE" });
    expect(german.status).toBe(200);
    const germanHtml = await german.text();
    expect(germanHtml).toContain("Betrieb");
    expect(germanHtml).toContain("Geprüft um");
    expect(germanHtml).not.toContain("Operations");
  });
});
