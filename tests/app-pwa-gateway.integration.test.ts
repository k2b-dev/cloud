import { afterAll, beforeAll, expect, test } from "bun:test";
import { appPwaCommand, createAppPwa } from "@k2b/cloud/app-pwa";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { invalidateIdentityRuntimeConfig } from "../../cloud/src/services/identity/runtime-config";
import { createTestSession } from "../../cloud/src/services/session/session.test-fixture";
import * as settings from "../../cloud/src/services/settings";
import { createProxyStats, proxyRequest } from "./proxy";
import { buildRouteTable } from "./trie";

const origin = "https://cloud.example.test";
const owner = "ca110000-0000-4000-8000-000000000001";
const path = "/app/pwa-fixture/counter/";
const pairResult = z.object({ id: z.uuid(), qr: z.string() });
const pwa = createAppPwa({
  app: { id: "pwa-fixture", installable: { path } },
  publicOrigin: origin,
  schema: "app_pwa_gateway_test",
  subject: z.object({ document: z.literal("fixture") }),
  budgets: { requestBytes: 4096, responseBytes: 4096, listPageSize: 10, maxAccessIds: 1 },
  authorizeStaff: async (_action, signIn) => signIn.userId === owner,
  authorizeVisit: async (_signIn, subject) => z.object({ document: z.literal("fixture") }).safeParse(subject).success,
  commands: {
    sign: appPwaCommand({
      input: z.object({ consent: z.literal(true) }),
      output: z.object({ saved: z.literal(true) }),
      handler: async ({ actor, tx, endVisit }) => {
        expect(actor.kind).toBe("visit");
        await tx`INSERT INTO app_pwa_gateway_test.signatures(visit_id) VALUES (${actor.visitId}::uuid)`;
        endVisit();
        return { saved: true };
      },
    }),
  },
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("App-PWA through the gateway and real Core identity authority", () => {
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let gateway: ReturnType<typeof Bun.serve> | undefined;
  let token: string;
  let previousUrl: string;
  let previousRate: number;
  beforeAll(async () => {
    previousUrl = await settings.get<string>("app.url");
    previousRate = await settings.get<number>("security.rate_limit_per_second");
    await settings.set("app.url", origin);
    await settings.set("security.rate_limit_per_second", 10000);
    invalidateIdentityRuntimeConfig();
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'app-pwa-gateway','local','user')`;
    token = await createTestSession(owner);
    await pwa.setup();
    await sql`CREATE TABLE app_pwa_gateway_test.signatures(visit_id uuid PRIMARY KEY)`;
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: pwa.router.fetch });
    const routes = buildRouteTable(
      ["/app/pwa-fixture", "/api/pwa-fixture"].map((prefix) => ({ prefix, appId: "pwa-fixture", baseUrl: upstream!.url.origin })),
    );
    const stats = createProxyStats();
    gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, server) => proxyRequest(request, routes, stats, () => {}, null, server.timeout.bind(server)),
    });
  });
  afterAll(async () => {
    await gateway?.stop(true);
    await upstream?.stop(true);
    await sql`DROP SCHEMA IF EXISTS app_pwa_gateway_test CASCADE`;
    await sql`DELETE FROM auth.users WHERE id=${owner}::uuid`;
    if (previousUrl !== undefined) await settings.set("app.url", previousUrl);
    if (previousRate !== undefined) await settings.set("security.rate_limit_per_second", previousRate);
    invalidateIdentityRuntimeConfig();
  });
  const post = (route: string, body: unknown, cookie?: string, csrf?: string) => {
    if (!gateway) throw new Error("Fixture not started");
    return fetch(new URL(route, gateway.url), {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "X-App-Pwa-CSRF": csrf } : {}) },
      body: JSON.stringify(body),
    });
  };
  const json = async (response: Response) => {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("x-gateway-app")).toBe("pwa-fixture");
    return response.json();
  };

  test("scan-only pairing binds the browser and commits a customer signature with its terminal visit and audit", async () => {
    const staff = pwa.router.staffApiPath;
    const guest = pwa.router.guestApiPath;
    const staffCookie = `session_token=${token}`;
    const staffCsrf = z.object({ csrf: z.string() }).parse(await json(await post(`${staff}/bootstrap`, {}, staffCookie))).csrf;
    const boot = await post(`${guest}/bootstrap`, {});
    const cookieHeader = boot.headers.get("set-cookie") ?? "";
    expect(cookieHeader.includes("Secure")).toBe(true);
    expect(cookieHeader.includes("HttpOnly")).toBe(true);
    expect(cookieHeader.includes("SameSite=Strict")).toBe(true);
    expect(cookieHeader.includes(`Path=${path}`)).toBe(true);
    const cookie = cookieHeader.split(";")[0]!;
    const csrf = z.object({ csrf: z.string() }).parse(await json(boot)).csrf;
    expect((await post(`${guest}/status`, {}, staffCookie, staffCsrf)).status).toBe(401);
    expect((await post(`${guest}/status`, {}, cookie, "wrong")).status).toBe(403);
    const device = pairResult.parse(
      await json(await post(`${staff}/devices/issue`, { requestId: crypto.randomUUID(), name: "Fixture iPad" }, staffCookie, staffCsrf)),
    );
    await json(await post(`${guest}/device/claim`, { qr: device.qr }, cookie, csrf));
    const visit = pairResult.parse(
      await json(
        await post(
          `${staff}/visits/issue`,
          { requestId: crypto.randomUUID(), deviceId: device.id, subject: { document: "fixture" } },
          staffCookie,
          staffCsrf,
        ),
      ),
    );
    await json(await post(`${guest}/visit/claim`, { qr: visit.qr }, cookie, csrf));
    const other = await post(`${guest}/bootstrap`, {});
    const otherCookie = other.headers.get("set-cookie")!.split(";")[0]!;
    const otherCsrf = z.object({ csrf: z.string() }).parse(await json(other)).csrf;
    expect((await post(`${guest}/device/claim`, { qr: device.qr }, otherCookie, otherCsrf)).status).toBe(409);
    const attemptId = crypto.randomUUID();
    const command = { visitId: visit.id, attemptId, input: { consent: true } };
    expect(await json(await post(`${guest}/command/sign`, command, cookie, csrf))).toEqual({
      state: "committed",
      completed: true,
      result: null,
      replayed: false,
    });
    expect(await json(await post(`${guest}/command/sign`, command, cookie, csrf))).toEqual({
      state: "committed",
      completed: true,
      result: null,
      replayed: true,
    });
    const [committed] = await sql<
      { count: number; state: string }[]
    >`SELECT (SELECT count(*)::int FROM app_pwa_gateway_test.signatures) AS count,state FROM app_pwa_gateway_test._cloud_pwa_visits WHERE id=${visit.id}::uuid`;
    expect(committed).toEqual({ count: 1, state: "ended" });
    const [audit] = await sql<
      { actor_user_id: string | null; kind: string }[]
    >`SELECT actor_user_id,metadata->>'actorKind' AS kind FROM audit.events WHERE action='app_pwa.visit.completed' AND metadata->>'visitId'=${visit.id}`;
    expect(audit).toEqual({ actor_user_id: null, kind: "visit" });
    await json(await post(`${staff}/devices/revoke`, { deviceId: device.id }, staffCookie, staffCsrf));
    expect((await post(`${guest}/status`, {}, cookie, csrf)).status).toBe(410);
  });
});
