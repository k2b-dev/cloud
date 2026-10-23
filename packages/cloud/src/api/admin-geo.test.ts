import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { GeoAdminStatus, GeoAdminUsage } from "../contracts/geo-admin";
import type { AuthContext } from "../server";
import { GeoAdminError, verifyGeoapifyKey } from "../services/geo/admin";
import { GeoapifyAdapter } from "../services/geo/geoapify";
import { buildProjectedUser } from "../services/session/user";
import { createAdminGeoRoutes } from "./admin-geo";

const actor = buildProjectedUser({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  display_name: "Admin",
  provider: "local",
  profile: "user",
  effective_admin: true,
});
const status: GeoAdminStatus = {
  key: { state: "set", setAt: "2026-10-19T10:00:00.000Z", setBy: { id: actor.id, name: "Admin" } },
  budget: {
    plan: "free",
    customRps: 5,
    customDailyCredits: 3000,
    monthlyCredits: 90000,
    personDailyCredits: 300,
    unreadable: [],
    changedAt: null,
    changedBy: null,
  },
  plans: {
    free: { dailyCredits: 3000, rps: 5 },
    api10: { dailyCredits: 10000, rps: 12 },
    api25: { dailyCredits: 25000, rps: 15 },
    api50: { dailyCredits: 50000, rps: 20 },
    api100: { dailyCredits: 100000, rps: 25 },
    api250: { dailyCredits: 250000, rps: 30 },
  },
  timezone: "Europe/Berlin",
};
const usage: GeoAdminUsage = {
  month: { period: "2026-10", used: 0, limit: 90000, resetsAt: "2026-10-31T23:00:00.000Z" },
  today: { period: "2026-10-20", used: 0, allowance: 3000, resetsAt: "2026-10-20T22:00:00.000Z" },
  shares: [],
  peopleAtLimit: 0,
  timezone: "Europe/Berlin",
};
const calls: string[] = [];
const service = {
  status: async () => (calls.push("status"), status),
  usage: async () => (calls.push("usage"), usage),
  setKey: async (_actor: unknown, key: string) => {
    calls.push(`setKey:${key.length}`);
    if (key === "refused") throw new GeoAdminError({ code: "geo_key_rejected" }, 422);
    return status;
  },
  removeKey: async () => (calls.push("removeKey"), status),
  saveBudget: async () => {
    calls.push("saveBudget");
    throw new GeoAdminError({ code: "geo_budget_invalid", errors: { personDailyCredits: { code: "above_monthly", max: 90000 } } }, 400);
  },
};
const withScopes =
  (scopes?: string[]): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("user", actor);
    if (scopes) c.set("oauthScopes", scopes);
    await next();
  };
const requests = [
  ["/", "GET", undefined],
  ["/usage", "GET", undefined],
  ["/key", "PUT", { apiKey: "secret-value" }],
  ["/key", "DELETE", undefined],
  ["/budget", "PUT", { plan: "free", customRps: 5, customDailyCredits: 3000, monthlyCredits: 9, personDailyCredits: 1 }],
] as const;
const send = (app: ReturnType<typeof createAdminGeoRoutes>, [path, method, body]: (typeof requests)[number]) =>
  app.request(path, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });

test("every route requires authentication and an administrator before the service", async () => {
  const denied: MiddlewareHandler<AuthContext> = async (c) => c.json({ code: "FORBIDDEN" }, 403);
  calls.length = 0;
  for (const request of requests) {
    expect((await send(createAdminGeoRoutes(), request)).status).toBe(401);
    expect((await send(createAdminGeoRoutes(denied, service), request)).status).toBe(403);
  }
  expect(calls).toEqual([]);
});

test("an OAuth token needs read to view and write to change", async () => {
  const statuses = async (scopes: string[]) => {
    const app = createAdminGeoRoutes(withScopes(scopes), service);
    return Promise.all(requests.map(async (request) => (await send(app, request)).status));
  };
  calls.length = 0;
  expect(await statuses(["read"])).toEqual([200, 200, 403, 403, 403]);
  expect(calls).toEqual(["status", "usage"]);
  expect(await statuses(["openid"])).toEqual([403, 403, 403, 403, 403]);
  expect(await statuses(["read", "write"])).toEqual([200, 200, 200, 200, 400]);
});

test("refusals return stable codes and never echo the key", async () => {
  const app = createAdminGeoRoutes(withScopes(), service);
  const refused = await app.request("/key", {
    method: "PUT",
    body: JSON.stringify({ apiKey: "refused" }),
    headers: { "content-type": "application/json" },
  });
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ code: "geo_key_rejected" });
  const accepted = await app.request("/key", {
    method: "PUT",
    body: JSON.stringify({ apiKey: "secret-value" }),
    headers: { "content-type": "application/json" },
  });
  expect(await accepted.text()).not.toContain("secret-value");
  const budget = await send(app, requests[4]);
  expect(await budget.json()).toEqual({
    code: "geo_budget_invalid",
    errors: { personDailyCredits: { code: "above_monthly", max: 90000 } },
  });
  const unknownField = await app.request("/key", {
    method: "PUT",
    body: JSON.stringify({ apiKey: "x", extra: true }),
    headers: { "content-type": "application/json" },
  });
  expect(unknownField.status).toBe(400);
});

test("the provider check sends the key only as a header and maps refusals and outages", async () => {
  const seen: Array<{ url: string; key: string | null }> = [];
  const check = (response: () => Response | Promise<Response>) =>
    verifyGeoapifyKey(
      new GeoapifyAdapter({
        fetch: async (url, init) => {
          seen.push({ url: url.toString(), key: new Headers(init.headers).get("x-api-key") });
          return response();
        },
      }),
    );
  const ok = () => Response.json({ type: "FeatureCollection", features: [] });
  await check(ok)("valid-key");
  expect(seen[0]?.url.startsWith("https://api-eu.geoapify.com/v1/geocode/reverse?")).toBe(true);
  expect(seen[0]?.url).not.toContain("valid-key");
  expect(seen[0]?.key).toBe("valid-key");
  const code = async (response: () => Response | Promise<Response>) =>
    ((await check(response)("some-key").catch((error: unknown) => error)) as GeoAdminError).body;
  expect(await code(() => new Response("nope", { status: 401 }))).toEqual({ code: "geo_key_rejected" });
  expect(await code(() => new Response("nope", { status: 403 }))).toEqual({ code: "geo_key_rejected" });
  expect(await code(() => new Response("busy", { status: 429 }))).toEqual({ code: "geo_key_unverified" });
  expect(await code(() => new Response("down", { status: 503 }))).toEqual({ code: "geo_key_unverified" });
  expect(
    await code(() => {
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    }),
  ).toEqual({ code: "geo_key_unverified" });
});
