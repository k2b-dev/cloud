import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { appAccessManagementPath } from "../_internal/app-access-path";
import * as registry from "../_internal/registry";
import { appAccess } from "../contracts/app-access";
import type { AppRegistryEntry } from "../contracts/registry";
import { requireAppAccess } from "../server/middleware/app-access";
import * as appUse from "../services/app-access";
import * as management from "../services/app-access-management";
import { oauthTokens } from "../services/oauth-tokens";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { APP_ACCESS_CHANGE_MAX_BYTES, createAppAccessRoutes, createOwnedAppAccessRoutes } from "./app-access";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: true });
const app: AppRegistryEntry = {
  baseUrl: "http://demo:3000",
  id: "demo",
  name: "Demo",
  icon: "ti ti-box",
  description: "Fictional app",
  routes: ["/api/demo", "/app/demo"],
  access: appAccess.grants(),
};
const snapshot: management.AppAccessSnapshot = {
  appId: app.id,
  name: app.name,
  entries: [],
  ownEntryIds: [],
  configured: false,
  hasEffectiveManager: false,
  inheritedSignedIn: false,
  canUse: false,
};
const change: management.AppAccessChange = { action: "grant", principal: { type: "authenticated" }, permission: "read" };
const post = (body: unknown = change): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const spies: { mockRestore(): void }[] = [];
let authenticated = true;
let failure: Error | undefined;
let reads: Parameters<typeof management.readAppAccess>[0][];
let writes: Parameters<typeof management.changeAppAccess>[0][];

beforeEach(() => {
  authenticated = true;
  failure = undefined;
  reads = [];
  writes = [];
  spies.push(spyOn(session, "getToken").mockReturnValue("fixture"));
  spies.push(
    spyOn(session, "authenticateRequest").mockImplementation(async () =>
      authenticated
        ? {
            user,
            data: { userId: user.id, sid: "fixture", authEpoch: 0, kind: "web", expiresAt: "2030-01-01T00:00:00Z" },
          }
        : null,
    ),
  );
  spies.push(spyOn(session, "appSessionFallback").mockReturnValue(null));
  spies.push(
    spyOn(registry, "getApp").mockImplementation(async (id) =>
      id === "demo" ? app : id === "fixed" ? { ...app, id, access: appAccess.signedIn() } : null,
    ),
  );
  spies.push(
    spyOn(management, "readAppAccess").mockImplementation(async (params) => {
      reads.push(params);
      if (failure) throw failure;
      return snapshot;
    }),
  );
  spies.push(
    spyOn(management, "changeAppAccess").mockImplementation(async (params) => {
      writes.push(params);
      if (failure) throw failure;
      return { canUse: false };
    }),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0).reverse()) spy.mockRestore();
});

test("stable Core URLs redirect GET and POST with a same-origin 307 and preserve the POST body", async () => {
  const routes = createAppAccessRoutes();
  const owner = createOwnedAppAccessRoutes(app);
  for (const init of [undefined, post()]) {
    const response = await routes.request("/demo", init);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/api/demo/_cloud/access/demo");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
  // The follow-up uses the original method and bytes, as fetch does for 307.
  const init = post();
  const response = await routes.request("/demo", init);
  expect((await owner.request(new URL(response.headers.get("location")!, "https://cloud.test").origin + "/", init)).status).toBe(200);
  expect(writes[0]?.change).toEqual(change);
  expect(writes[0]?.repair).toBeUndefined();
});

test("repair=1 handles Core directly and is never selected implicitly or by the app-local query", async () => {
  const routes = createAppAccessRoutes();
  expect(await (await routes.request("/demo?repair=1")).json()).toEqual(snapshot);
  expect((await routes.request("/demo?repair=1", post())).status).toBe(200);
  expect(reads[0]?.repair).toBe(true);
  expect(writes[0]?.repair).toBe(true);
  expect((await routes.request("/demo?repair=true")).status).toBe(400);
  const canManage = () => false;
  await createOwnedAppAccessRoutes(app, canManage).request("/?repair=1", post());
  expect(writes[1]?.repair).toBeUndefined();
  expect(writes[1]?.canManage).toBe(canManage);
  expect(writes[1]?.authority).toMatchObject({ credentialKind: "session", scopes: [], accessSubject: { type: "user", userId: user.id } });
});

test("anonymous callers cannot read, write, repair or obtain a redirect", async () => {
  authenticated = false;
  for (const [routes, path] of [
    [createAppAccessRoutes(), "/demo?repair=1"],
    [createOwnedAppAccessRoutes(app), "/?repair=1"],
  ] as const) {
    for (const init of [undefined, post()]) {
      const response = await routes.request(path, init);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  }
  expect(reads).toHaveLength(0);
  expect(writes).toHaveLength(0);
});

test("unknown and fixed apps and management errors retain their HTTP status and stable codes", async () => {
  const routes = createAppAccessRoutes();
  for (const init of [undefined, post()]) {
    expect((await routes.request("/missing", init)).status).toBe(404);
    expect((await routes.request("/fixed", init)).status).toBe(409);
  }
  for (const [code, status] of [
    ["FORBIDDEN", 403],
    ["LAST_MANAGER", 409],
    ["NOT_FOUND", 404],
  ] as const) {
    failure = new management.AppAccessManagementError(code, "Fictional denial", status);
    for (const init of [undefined, post()]) {
      const response = await routes.request("/demo?repair=1", init);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code, message: "Fictional denial" });
    }
  }
});

test("strict mutation validation and the 4 KiB byte limit run before any mutation or redirect", async () => {
  for (const [routes, path] of [
    [createAppAccessRoutes(), "/demo"],
    [createOwnedAppAccessRoutes(app), "/"],
  ] as const) {
    for (const body of [
      { ...change, permission: "write" },
      { ...change, extra: true },
      { action: "revoke", accessId: "not-a-uuid" },
    ]) {
      expect((await routes.request(path, post(body))).status).toBe(400);
    }
    expect((await routes.request(path, { ...post(), body: "{" })).status).toBe(400);
    const valid = JSON.stringify(change);
    expect(
      (await routes.request(path, { ...post(), body: valid + " ".repeat(APP_ACCESS_CHANGE_MAX_BYTES - valid.length) })).status,
    ).toBeLessThan(400);
    expect(
      (await routes.request(path, { ...post(), body: valid + " ".repeat(APP_ACCESS_CHANGE_MAX_BYTES + 1 - valid.length) })).status,
    ).toBe(413);
    expect((await routes.request(path, post({ ...change, padding: "ä".repeat(APP_ACCESS_CHANGE_MAX_BYTES / 2) }))).status).toBe(413);
  }
  expect(writes).toHaveLength(1);
});

test("OAuth credential kind and scope caps reach management unchanged", async () => {
  authenticated = false;
  spies.push(spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} }));
  const routes = createOwnedAppAccessRoutes(app);
  expect(
    (await routes.request("/", { ...post(), headers: { "content-type": "application/json", authorization: "Bearer fixture-oauth" } }))
      .status,
  ).toBe(200);
  expect(writes[0]?.authority).toMatchObject({
    credentialKind: "oauth",
    scopes: ["read"],
    accessSubject: { type: "user", userId: user.id },
  });
});

test("the redirect reaches the owner's mounted route before the app-use gate without a trailing-slash mismatch", async () => {
  const checkUse = spyOn(appUse, "canUseApp").mockResolvedValue(false);
  spies.push(checkUse);
  const owner = new Hono()
    .route(appAccessManagementPath(app), createOwnedAppAccessRoutes(app))
    .use(
      "*",
      requireAppAccess(app, async () => new Response("denied", { status: 403 })),
    )
    .all("*", (c) => c.text("private"));
  const core = createAppAccessRoutes();
  for (const init of [undefined, post()]) {
    const redirect = await core.request("/demo", init);
    expect(redirect.status).toBe(307);
    const target = redirect.headers.get("location")!;
    expect(target.startsWith("/api/demo/")).toBe(true);
    const response = await owner.request(target, init);
    expect(response.status).toBe(200);
  }
  expect(checkUse).not.toHaveBeenCalled();
  expect(reads).toHaveLength(1);
  expect(writes).toHaveLength(1);
});
