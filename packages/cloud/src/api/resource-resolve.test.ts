import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { oauthTokens } from "../services/oauth-tokens";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { createResourceResolveRoutes } from "./resource-resolve";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user" });
const spies: { mockRestore(): void }[] = [];
let authenticated = true;
beforeEach(() => {
  authenticated = true;
  spies.push(spyOn(session, "getToken").mockReturnValue("fixture"));
  spies.push(
    spyOn(session, "authenticateRequest").mockImplementation(async () =>
      authenticated
        ? {
            user,
            data: { userId: user.id, sid: "fixture", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
          }
        : null,
    ),
  );
  spies.push(spyOn(session, "appSessionFallback").mockReturnValue(null));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const routes = (resolve: Parameters<typeof createResourceResolveRoutes>[0]) =>
  new Hono().route("/api/resources", createResourceResolveRoutes(resolve));

test("Core returns the same 404 body for invalid input, foreign, unknown, denied, missing and failed resources", async () => {
  const requests = [
    { url: "https://foreign.example/private" },
    { url: "/unknown" },
    { url: "/denied" },
    { url: "/missing" },
    {},
    { url: 123 },
    { url: "a".repeat(8193) },
    { url: "/app/demo/id", extra: true },
  ];
  const bodies = [];
  const app = routes(async () => null);
  for (const input of requests) {
    const response = await app.request("/api/resources/resolve", post(input));
    expect(response.status).toBe(404);
    bodies.push(await response.text());
  }
  const offline = await routes(async () => {
    throw new Error("private provider failure");
  }).request("/api/resources/resolve", post({ url: "/offline" }));
  expect(offline.status).toBe(404);
  bodies.push(await offline.text());
  const malformed = await app.request("/api/resources/resolve", { ...post({}), body: "invalid JSON" });
  expect(malformed.status).toBe(404);
  bodies.push(await malformed.text());
  expect(new Set(bodies)).toEqual(new Set(['{"error":"Resource not found"}']));
});

test("Core resolves under the authenticated authority with the capability request timeout", async () => {
  const calls: number[] = [];
  const resource = { ref: { type: "demo.item", id: "id" }, title: "Item", icon: "ti ti-box", href: "/app/demo/id" };
  const app = routes(async (params) => {
    expect(params.url).toBe("/app/demo/id");
    expect(params.authority.actor.kind).toBe("user");
    expect(params.authority.accessSubject).toEqual({ type: "user", userId: user.id });
    expect(calls).toEqual([55]);
    return resource;
  });
  const response = await app.fetch(new Request("https://cloud.example/api/resources/resolve", post({ url: "/app/demo/id" })), {
    timeout: (_request: Request, seconds: number) => calls.push(seconds),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(resource);
  expect(calls).toEqual([55, 10]);
});

test("Core rejects signed-out callers before resolving and advertises the route in OpenAPI", async () => {
  authenticated = false;
  let calls = 0;
  const app = routes(async () => {
    calls++;
    return null;
  });
  expect((await app.request("/api/resources/resolve", post({ url: "/app/demo/id" }))).status).toBe(401);
  expect(calls).toBe(0);
  const spec = await generateSpecs(app);
  expect(spec.paths?.["/api/resources/resolve"]?.post?.responses).toHaveProperty("404");
});

test("the read-only POST accepts OAuth read scope and forwards its authority unchanged", async () => {
  authenticated = false;
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["read"], payload: {} });
  spies.push(verify);
  let calls = 0;
  const app = routes(async ({ authority }) => {
    calls++;
    expect(authority.credentialKind).toBe("oauth");
    expect(authority.scopes).toEqual(["read"]);
    return { ref: { type: "demo.item", id: "id" }, title: "Item", href: "/app/demo/id" };
  });
  const request = {
    ...post({ url: "/app/demo/id" }),
    headers: { "content-type": "application/json", authorization: "Bearer fixture-oauth" },
  };
  expect((await app.request("/api/resources/resolve", request)).status).toBe(200);
  verify.mockResolvedValue({ kind: "user", user, scopes: ["write"], payload: {} });
  expect((await app.request("/api/resources/resolve", request)).status).toBe(403);
  expect(calls).toBe(1);
});
