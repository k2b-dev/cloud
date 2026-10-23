import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { appRegistry } from "../../_internal/registry";
import type { AppRegistryEntry } from "../../contracts/registry";
import { publishAppAccessChanged, wakeAppAccessChanged } from "../../events/app-access";
import { startLiveOutbox } from "../../events/live";
import { invocationAuthorityFromRequest } from "../../services/identity/invocation-authority";
import { issueInvocationToken } from "../../services/identity/issue-invocation";
import { mandates } from "../../services/mandates";
import { session } from "../../services/session";
import { createTestSession } from "../../services/session/session.test-fixture";
import { guardAppAccessSocket, requireAppAccess } from "./app-access";
import { type AuthContext, auth } from "./auth";
import { requireInvocation } from "./invocation";

const suite = suiteFor("database", "nats", "valkey");
const appId = "enforcementtest";
const entry: AppRegistryEntry = {
  id: appId,
  name: "Enforcement test",
  icon: "ti ti-test-pipe",
  description: "Fixture",
  baseUrl: "http://enforcementtest:3000",
  routes: ["/api/enforcementtest"],
  access: { kind: "grants", publicRoutes: ["/public/:token"] },
};
const invocationPath = "/internal";
let server: ReturnType<typeof Bun.serve> | undefined;
let stopOutbox: (() => Promise<void>) | null = null;
let userId = "",
  token = "",
  accessId = "";
const mandateIds: string[] = [];
let privateCalls = 0;
/** Bun accepts handshake headers; the portable DOM constructor types do not. */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
const sockets = new Set<WebSocket>();
const requests = new Set<AbortController>();
let sseStopped = 0;

const headers = () => ({ cookie: `session_token=${token}` });
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Live access change did not arrive");
    await Bun.sleep(10);
  }
};
const changeGrant = async (granted: boolean) => {
  await sql.begin(async (tx) => {
    if (granted) await tx`INSERT INTO auth.app_access (app_id, access_id) VALUES (${appId}, ${accessId}::uuid) ON CONFLICT DO NOTHING`;
    else await tx`DELETE FROM auth.app_access WHERE app_id = ${appId} AND access_id = ${accessId}::uuid`;
    await publishAppAccessChanged(tx, appId);
  });
  wakeAppAccessChanged();
};

suite("application enforcement and revocation", () => {
  beforeAll(async () => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
      VALUES (${"enforcement-" + crypto.randomUUID()}, 'local', 'user', 'Enforcement test') RETURNING id`;
    userId = user!.id;
    token = await createTestSession(userId);
    await sql`INSERT INTO auth.app_access_state (app_id, configured_at) VALUES (${appId}, now())`;
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'read') RETURNING id`;
    accessId = access!.id;
    await appRegistry().upsert({ key: `apps/${appId}`, value: entry });
    stopOutbox = await startLiveOutbox("core");
    const app = new Hono<AuthContext>()
      .post(
        invocationPath,
        requireInvocation(() => ({ targetAppId: appId, operation: "capability.query:read", schemaHash: null })),
        (c) => {
          privateCalls++;
          return c.json({ secret: true });
        },
      )
      .use(requireAppAccess(entry, async (_c, message) => new Response(message, { status: 403, headers: { "content-type": "text/html" } })))
      .get("/private", (c) => {
        privateCalls++;
        return c.json({ secret: true });
      })
      .get("/public/:token", (c) => c.text("public"))
      .get(
        "/socket",
        auth.requireRole("authenticated"),
        upgradeWebSocket(async (c) =>
          guardAppAccessSocket(c, appId, {
            onOpen: (_event, ws) => ws.send("ready"),
            onMessage: (_event, ws) => ws.send("private"),
          }),
        ),
      )
      .get("/events", (c) =>
        streamSSE(c, async (stream) => {
          await stream.writeSSE({ data: "ready" });
          await new Promise<void>((resolve) => stream.onAbort(resolve));
          sseStopped++;
        }),
      );
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
  });

  afterAll(async () => {
    for (const request of requests) request.abort();
    for (const socket of sockets) socket.close();
    await server?.stop(true);
    await stopOutbox?.();
    if (token) await session.revokeAllForUser(userId);
    await appRegistry().delete({ key: `apps/${appId}` });
    await sql`DELETE FROM events.outbox WHERE kind = 'live' AND app_id = 'core' AND ordering_key = ${`app.access:${appId}`}`;
    await sql`DELETE FROM auth.app_access WHERE app_id = ${appId}`;
    await sql`DELETE FROM auth.app_access_state WHERE app_id = ${appId}`;
    for (const id of mandateIds) {
      await sql`DELETE FROM audit.events WHERE target_type = 'mandate' AND target_id = ${id}`;
      await sql`DELETE FROM auth.mandates WHERE id = ${id}::uuid`;
    }
    if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("API, SSR and socket handshakes deny before app code; explicit public routes stay open", async () => {
    const call = (path: string, extra: HeadersInit = {}) => fetch(new URL(path, server!.url), { headers: { ...headers(), ...extra } });
    for (const [path, extra] of [
      ["/private", {}],
      ["/private", { accept: "text/html" }],
      ["/socket", { upgrade: "websocket" }],
    ] as const) {
      const response = await call(path, extra);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("secret");
    }
    expect(privateCalls).toBe(0);
    expect((await fetch(new URL("/public/share", server!.url))).status).toBe(200);
    await changeGrant(true);
    expect((await call("/private")).status).toBe(200);
    await changeGrant(false);
  });

  test("issuer refuses inaccessible apps and receiver rechecks a previously issued token after revocation", async () => {
    const authorityRoute = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated"))
      .get("/", async (c) => {
        const signed = await issueInvocationToken({
          targetAppId: appId,
          callingAppId: "core",
          operation: "capability.query:read",
          schemaHash: null,
          authority: invocationAuthorityFromRequest(auth.getAuthority(c)),
        });
        return c.text(signed.token);
      })
      .onError((error, c) => c.json({ code: "app_access_denied", message: error.message }, 403));
    expect((await authorityRoute.request("/", { headers: headers() })).status).toBe(403);
    await changeGrant(true);
    const issued = await authorityRoute.request("/", { headers: headers() });
    expect(issued.status).toBe(200);
    const invocation = await issued.text();
    const invoke = () =>
      fetch(new URL(invocationPath, server!.url), { method: "POST", headers: { authorization: `Bearer ${invocation}` } });
    expect((await invoke()).status).toBe(200);
    await changeGrant(false);
    const denied = await invoke();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "app_access_denied", app: appId });
  });

  test("mandate issuance and resume check the subject's current app access, including administrator-initiated resume", async () => {
    const created = await mandates.create({
      authority: { kind: "interactive", userId },
      subject: { type: "user", id: userId },
      ownerAppId: appId,
      workloadType: "test.job",
      workloadId: "enforcement",
      policy: {
        version: 1,
        apps: [appId],
        operations: ["capability.query:read"],
        actions: "deny",
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    mandateIds.push(created.data.id);
    let callbacks = 0;
    const issue = () =>
      mandates.withIssueAuthority(
        { mandateId: created.data.id, ownerAppId: appId, targetAppId: appId, operation: "capability.query:read" },
        async () => {
          callbacks++;
          return "issued";
        },
      );
    expect((await issue()).ok).toBe(false);
    expect(callbacks).toBe(0);
    await changeGrant(true);
    expect((await issue()).ok).toBe(true);
    expect(callbacks).toBe(1);
    const paused = await mandates.pause({
      mandateId: created.data.id,
      expectedRevision: created.data.revision,
      authority: { kind: "interactive", userId },
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    await changeGrant(false);
    const resume = () =>
      mandates.resume({ mandateId: created.data.id, expectedRevision: paused.data.revision, authority: { kind: "admin", userId } });
    expect((await resume()).ok).toBe(false);
    await changeGrant(true);
    expect((await resume()).ok).toBe(true);
    await changeGrant(false);
  });

  test("rolled-back access changes enqueue no invalidation and leave grants unchanged", async () => {
    const rows: string[] = [];
    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO auth.app_access (app_id, access_id) VALUES (${appId}, ${accessId}::uuid)`;
        const before = new Set(
          (
            await tx<{ id: string }[]>`SELECT id FROM events.outbox WHERE kind = 'live' AND app_id = 'core'
          AND ordering_key = ${`app.access:${appId}`}`
          ).map((row) => row.id),
        );
        await publishAppAccessChanged(tx, appId);
        rows.push(
          ...(
            await tx<{ id: string }[]>`SELECT id FROM events.outbox WHERE kind = 'live' AND app_id = 'core'
        AND ordering_key = ${`app.access:${appId}`}`
          )
            .map((row) => row.id)
            .filter((id) => !before.has(id)),
        );
        throw new Error("rollback access change");
      }),
    ).rejects.toThrow("rollback access change");
    expect(rows.length).toBeGreaterThan(0);
    expect(await sql`SELECT 1 FROM events.outbox WHERE id IN ${sql(rows)}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM auth.app_access WHERE app_id = ${appId}`).toHaveLength(0);
  });

  test("transactional app.access.changed revokes an open custom socket and SSE, cancelling their resources", async () => {
    await changeGrant(true);
    const socket = new BunWebSocket(new URL("/socket", server!.url).toString().replace("http:", "ws:"), { headers: headers() });
    sockets.add(socket);
    let closed = "",
      ready = false;
    socket.onmessage = (message) => {
      if (message.data === "ready") ready = true;
    };
    socket.onclose = (event) => {
      closed = event.reason;
    };
    await until(() => ready);
    const controller = new AbortController();
    requests.add(controller);
    const response = await fetch(new URL("/events", server!.url), { headers: headers(), signal: controller.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    await changeGrant(false);
    await until(() => closed === "app_access_denied");
    let text = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      text += new TextDecoder().decode(result.value);
    }
    expect(text).toContain("app_access_denied");
    await until(() => sseStopped > 0);
    controller.abort();
    requests.delete(controller);
    sockets.delete(socket);
  });
});
