import { expect, test } from "bun:test";
import { Hono } from "hono";
import { person } from "../_internal/define-app.test-fixture";
import type { CloudRuntime } from "../contracts/app";
import type { AuthContext } from "../server";
import { createMePanelConsentRoutes } from "./me-panel-consent";

test("personal panel consent authenticates, filters the live registry and separates people", async () => {
  const stored = new Map<string, boolean>();
  const service = {
    get: async (id: string, provider: string) => stored.get(`${id}:${provider}`) ?? null,
    list: async (id: string, providers: string[]) =>
      Object.fromEntries(providers.flatMap((p) => (stored.has(`${id}:${p}`) ? [[p, stored.get(`${id}:${p}`)!]] : []))),
    set: async (id: string, provider: string, allowed: boolean) => {
      stored.set(`${id}:${provider}`, allowed);
      return allowed;
    },
  };
  const routes = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", async (c, next) => {
      c.set("user", { ...person, id: c.req.header("test-person") ?? person.id });
      c.set("runtime", {
        apps: ["core", "fixture", "other", "plain"].map((id) => ({
          id,
          name: id,
          icon: "ti ti-box",
          description: "Fixture",
          routes: [`/app/${id}`],
          ...(id !== "plain" ? { panel: { href: `/app/${id}/panel`, label: id, icon: "ti ti-box" } } : {}),
        })),
      });
      await next();
    })
    .route("/", createMePanelConsentRoutes(service));
  const put = (provider: string, body: unknown, user = person.id) =>
    routes.request(`/panel-consent/${provider}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "test-person": user },
      body: JSON.stringify(body),
    });
  expect((await createMePanelConsentRoutes(service).request("/panel-consent")).status).toBe(401);
  for (const provider of ["unknown", "core", "plain"])
    expect(await (await put(provider, { allowed: true })).json()).toMatchObject({ code: "PANEL_PROVIDER_NOT_FOUND" });
  expect(stored.size).toBe(0);
  expect((await put("fixture", { allowed: true, userId: "another" })).status).toBe(400);
  expect((await put("fixture", { allowed: "true" })).status).toBe(400);
  expect((await put("fixture", { allowed: true, padding: "x".repeat(300) })).status).toBe(413);
  expect(await (await put("fixture", { allowed: true })).json()).toEqual({ provider: "fixture", allowed: true });
  expect(await (await put("other", { allowed: false })).json()).toEqual({ provider: "other", allowed: false });
  const answer = await routes.request("/panel-consent?userId=another");
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(await answer.json()).toEqual({ answers: { fixture: true, other: false } });
  expect(
    await (await routes.request("/panel-consent", { headers: { "test-person": "22222222-2222-4222-8222-222222222222" } })).json(),
  ).toEqual({ answers: {} });
  expect((await put("fixture", { allowed: false })).status).toBe(200);
  expect(stored.size).toBe(2);
});
