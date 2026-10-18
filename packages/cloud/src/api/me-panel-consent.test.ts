import { expect, test } from "bun:test";
import { Hono } from "hono";
import { person } from "../_internal/define-app.test-fixture";
import type { CloudRuntime } from "../contracts/app";
import type { AuthContext } from "../server";
import { createMePanelConsentRoutes } from "./me-panel-consent";

test("personal panel consent authenticates, filters the live registry and separates people", async () => {
  const stored = new Map<string, { allowed: boolean; revision: number }>();
  const service = {
    get: async (id: string, provider: string) => stored.get(`${id}:${provider}`) ?? null,
    list: async (id: string, providers: string[]) =>
      Object.fromEntries(providers.flatMap((p) => (stored.has(`${id}:${p}`) ? [[p, stored.get(`${id}:${p}`)!]] : []))),
    set: async (id: string, provider: string, allowed: boolean, revision: number) => {
      if ((stored.get(`${id}:${provider}`)?.revision ?? 0) !== revision) return null;
      const saved = { allowed, revision: revision + 1 };
      stored.set(`${id}:${provider}`, saved);
      return saved;
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
    expect(await (await put(provider, { allowed: true, revision: 0 })).json()).toMatchObject({ code: "PANEL_PROVIDER_NOT_FOUND" });
  expect(stored.size).toBe(0);
  expect((await put("fixture", { allowed: true, revision: 0, userId: "another" })).status).toBe(400);
  expect((await put("fixture", { allowed: "true", revision: 0 })).status).toBe(400);
  for (const body of [{ allowed: true }, ...[-1, 0.5, "0", null].map((revision) => ({ allowed: true, revision }))])
    expect((await put("fixture", body)).status).toBe(400);
  expect((await put("fixture", { allowed: true, revision: 0, padding: "x".repeat(300) })).status).toBe(413);
  expect(await (await put("fixture", { allowed: true, revision: 0 })).json()).toEqual({ provider: "fixture", allowed: true, revision: 1 });
  expect(await (await put("other", { allowed: false, revision: 0 })).json()).toEqual({ provider: "other", allowed: false, revision: 1 });
  const answer = await routes.request("/panel-consent?userId=another");
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(await answer.json()).toEqual({ answers: { fixture: { allowed: true, revision: 1 }, other: { allowed: false, revision: 1 } } });
  expect(
    await (await routes.request("/panel-consent", { headers: { "test-person": "22222222-2222-4222-8222-222222222222" } })).json(),
  ).toEqual({ answers: {} });
  const conflict = await put("fixture", { allowed: false, revision: 0 });
  expect(conflict.status).toBe(409);
  expect(conflict.headers.get("cache-control")).toBe("no-store");
  expect(await conflict.json()).toMatchObject({ code: "CONFLICT", message: expect.any(String) });
  expect(await (await routes.request("/panel-consent")).json()).toEqual({
    answers: { fixture: { allowed: true, revision: 1 }, other: { allowed: false, revision: 1 } },
  });
  const saved = await put("fixture", { allowed: false, revision: 1 });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ provider: "fixture", allowed: false, revision: 2 });
  expect((await put("fixture", { allowed: true, revision: 1 })).status).toBe(409);
  expect(stored.size).toBe(2);
});

test("a save the browser gave up on answers 503 and stores nothing", async () => {
  const { PanelConsentCancelled } = await import("../services/panel-context-consent");
  const service = {
    get: async () => null,
    list: async () => ({}),
    set: async (): Promise<{ allowed: boolean; revision: number } | null> => {
      throw new PanelConsentCancelled();
    },
  };
  const routes = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>()
    .use("*", async (c, next) => {
      c.set("user", person);
      c.set("runtime", {
        apps: [
          {
            id: "fixture",
            name: "fixture",
            icon: "ti ti-box",
            description: "Fixture",
            routes: ["/app/fixture"],
            panel: { href: "/app/fixture/panel", label: "fixture", icon: "ti ti-box" },
          },
        ],
      });
      await next();
    })
    .route("/", createMePanelConsentRoutes(service));
  const response = await routes.request("/panel-consent/fixture", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowed: false, revision: 1 }),
  });
  expect(response.status).toBe(503);
});
