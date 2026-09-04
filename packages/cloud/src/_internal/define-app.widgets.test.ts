import { expect, spyOn, test } from "bun:test";
import { type Handler, Hono } from "hono";
import { env } from "../config/env";
import type { User } from "../contracts/shared";
import { getLocale } from "../server/locale";
import { type AuthContext, auth } from "../server/middleware/auth";
import { runtime } from "../server/middleware/runtime";
import { settings } from "../server/middleware/settings";
import * as invocationActor from "../services/identity/invocation-actor";
import * as invocationToken from "../services/identity/invocation-token";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import * as settingsSnapshot from "../services/settings/snapshot";
import { getRuntimeContext } from "../ssr/runtime";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import * as watcher from "./runtime-watcher";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reviewer",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Review",
  sn: "User",
  displayName: "Review User",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};
const claims: invocationToken.CloudInvocationClaims = {
  iss: "https://cloud.example",
  aud: "app:widget-context",
  token_use: "invocation",
  sub: user.id,
  principal_type: "user",
  access_subject_type: "user",
  access_subject_id: user.id,
  act: { sub: "app:core" },
  credential_kind: "session",
  scopes: [],
  op: "widget.read:context",
  schema_hash: null,
  ver: 1,
  jti: "22222222-2222-4222-8222-222222222222",
  iat: 100,
  nbf: 100,
  exp: 130,
};
const invocationCandidate = `${Buffer.from(
  JSON.stringify({
    alg: "RS256",
    kid: "33333333-3333-4333-8333-333333333333",
    typ: "cloud-invocation+jwt",
  }),
).toString("base64url")}.e30.signature`;

test("internal invocation widgets receive runtime, settings, actor and locale like the public handler", async () => {
  let activeClaims = claims;
  let handlerCalls = 0;
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "widget-context-test-only", configurable: true });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  const spies = [
    spyOn(heartbeat, "createHeartbeat").mockReturnValue({ start: async () => {}, stop: async () => {} }),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
    spyOn(settingsService, "loadCache").mockResolvedValue(),
    spyOn(settingsSnapshot, "loadSnapshot").mockResolvedValue({ app: { locale: "en" } }),
    spyOn(invocationToken, "verifyInvocationToken").mockImplementation(async (_token, expected) => {
      expect(expected).toEqual({ targetAppId: "widget-context", operation: "widget.read:context", schemaHash: null });
      return activeClaims;
    }),
    spyOn(invocationActor, "resolveInvocationAuthority").mockImplementation(async () => ({
      actor: { kind: "user", user },
      accessSubject: { type: "user", userId: user.id },
      credentialKind: "invocation",
      scopes: activeClaims.scopes,
    })),
    spyOn(auth, "requireRole").mockReturnValue(async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("accessSubject", { type: "user", userId: user.id });
      c.set("credentialKind", "session");
      c.set("credentialScopes", []);
      await next();
    }),
  ];
  try {
    const handler: Handler<AuthContext> = (c) => {
      handlerCalls += 1;
      return c.json({
        runtimeApps: getRuntimeContext(c).apps,
        settings: Reflect.get(c.var, "settings"),
        actorKind: c.get("actor").kind,
        userId: c.get("user").id,
        locale: getLocale(c),
      });
    };
    const publicRoutes = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated"), runtime(), settings())
      .get("/api/widget-context/widget", handler);
    const app = defineApp({
      id: "widget-context",
      name: "Widget Context",
      icon: "ti ti-box",
      description: "Context regression test",
      baseUrl: "http://widget-context:3000",
      routes: ["/api/widget-context"],
      widgets: [{ id: "context", path: "/api/widget-context/widget" }],
    });
    const server = await app.start({ fetch: publicRoutes.fetch, widgets: { context: handler } });
    const headers = { authorization: `Bearer ${invocationCandidate}`, "x-cloud-locale": "de-CH" };
    const internal = await server.fetch(new Request("http://widget-context/api/_internal/widgets/v1/context", { headers }));
    const direct = await server.fetch(new Request("http://widget-context/api/widget-context/widget", { headers }));
    expect(internal.status).toBe(200);
    expect(direct.status).toBe(200);
    const body = await internal.json();
    expect(body).toEqual(await direct.json());
    expect(body).toEqual({ runtimeApps: [], settings: { app: { locale: "en" } }, actorKind: "user", userId: user.id, locale: "de-CH" });
    for (const scopes of [[], ["openid", "profile"], ["write"], ["read"], ["admin"]]) {
      activeClaims = { ...claims, credential_kind: "oauth", scopes };
      const previousCalls = handlerCalls;
      const response = await server.fetch(new Request("http://widget-context/api/_internal/widgets/v1/context", { headers }));
      const allowed = scopes.includes("read") || scopes.includes("admin");
      expect(response.status).toBe(allowed ? 200 : 403);
      expect(handlerCalls - previousCalls).toBe(allowed ? 1 : 0);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
    Object.defineProperty(env, "APP_SECRET", originalSecret);
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!previousListeners[index]!.has(listener)) process.removeListener(signal, listener);
      }
    }
  }
});
