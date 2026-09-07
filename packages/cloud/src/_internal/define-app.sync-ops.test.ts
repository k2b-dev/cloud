import { expect, spyOn, test } from "bun:test";
import type { Sync } from "@k2b/sync";

import { env } from "../config/env";
import type { User } from "../contracts/shared";
import { auth } from "../server/middleware/auth";
import * as invocationActor from "../services/identity/invocation-actor";
import { syncInvocationOperation } from "../services/identity/invocation-operations";
import * as invocationToken from "../services/identity/invocation-token";
import * as notificationCatalog from "../services/notifications/catalog";
import * as settingsService from "../services/settings";
import * as settingsSnapshot from "../services/settings/snapshot";
import { defineApp } from "./define-app";
import * as heartbeat from "./heartbeat";
import * as processSync from "./process-sync";
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
  aud: "app:sync-context",
  token_use: "invocation",
  sub: user.id,
  principal_type: "user",
  access_subject_type: "user",
  access_subject_id: user.id,
  act: { sub: "app:core" },
  credential_kind: "session",
  scopes: [],
  op: syncInvocationOperation("GET", "/resources"),
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

test("internal Sync operations require a bound invocation and current admin authority", async () => {
  let activeClaims = claims;
  let resourceReads = 0;
  let currentUser = user;
  const originalSecret = Object.getOwnPropertyDescriptor(env, "APP_SECRET")!;
  Object.defineProperty(env, "APP_SECRET", { value: "widget-context-test-only", configurable: true });
  const signals = ["SIGTERM", "SIGINT"] as const;
  const previousListeners = signals.map((signal) => new Set(process.listeners(signal)));
  // The heartbeats are stubbed, so the registry handles declared on this fake are never used.
  const fakeSync = {
    ready: async () => {},
    ephemeral: () => ({}),
    resources: async () => {
      resourceReads++;
      return [];
    },
    health: () => ({ state: "ready", connection: "connected" }),
  } as unknown as Sync;
  const spies = [
    spyOn(processSync, "startProcessSync").mockImplementation(async () => {
      processSync.bindProcessSync(fakeSync);
      return { sync: fakeSync, stop: async () => processSync.unbindProcessSync() };
    }),
    spyOn(heartbeat, "createHeartbeat").mockReturnValue({ start: async () => {}, stop: async () => {} }),
    spyOn(watcher, "ensureRuntimeWatcher").mockResolvedValue(),
    spyOn(watcher, "getCurrentRuntime").mockReturnValue({ apps: [] }),
    spyOn(notificationCatalog, "startNotificationDefinitionRegistration").mockResolvedValue(() => {}),
    spyOn(settingsService, "loadCache").mockResolvedValue(),
    spyOn(settingsSnapshot, "loadSnapshot").mockResolvedValue({ app: { locale: "en" } }),
    spyOn(invocationToken, "verifyInvocationToken").mockImplementation(async (_token, expected) => {
      expect(expected).toEqual({ targetAppId: "sync-context", operation: syncInvocationOperation("GET", "/resources"), schemaHash: null });
      return activeClaims.op === expected.operation ? activeClaims : null;
    }),
    spyOn(invocationActor, "resolveInvocationAuthority").mockImplementation(async () => ({
      actor: { kind: "user", user: currentUser },
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
    const app = defineApp({
      id: "sync-context",
      name: "Sync Context",
      icon: "ti ti-box",
      description: "Sync authority regression",
      baseUrl: "http://sync-context:3000",
      routes: ["/api/sync-context"],
    });
    const server = await app.start({ fetch: () => new Response("App fallback") });
    const request = (headers: HeadersInit = {}) => server.fetch(new Request("http://sync-context/_internal/sync/resources", { headers }));
    expect((await request({ cookie: "session_token=source" })).status).toBe(401);
    expect((await request({ authorization: "Bearer source" })).status).toBe(401);
    expect(resourceReads).toBe(0);
    const headers = { authorization: `Bearer ${invocationCandidate}` };
    expect((await request(headers)).status).toBe(403);
    expect(resourceReads).toBe(0);
    currentUser = { ...user, roles: ["admin"] };
    for (const scopes of [[], ["read"], ["write"], ["admin"]]) {
      activeClaims = { ...claims, credential_kind: "oauth", scopes };
      const previousReads = resourceReads;
      const response = await request(headers);
      expect(response.status).toBe(scopes.includes("admin") ? 200 : 403);
      expect(resourceReads - previousReads).toBe(scopes.includes("admin") ? 1 : 0);
    }
    activeClaims = { ...claims, op: syncInvocationOperation("DELETE", "/resources") };
    expect((await request(headers)).status).toBe(401);
    activeClaims = claims;
    expect((await request(headers)).status).toBe(200);
  } finally {
    for (const spy of spies) spy.mockRestore();
    processSync.unbindProcessSync();
    Object.defineProperty(env, "APP_SECRET", originalSecret);
    for (const [index, signal] of signals.entries()) {
      for (const listener of process.listeners(signal)) {
        if (!previousListeners[index]!.has(listener)) process.removeListener(signal, listener);
      }
    }
  }
});
