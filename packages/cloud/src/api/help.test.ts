import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { fixtureHelpReader } from "../../test/help-reader";
import type { RequestActor } from "../contracts/shared";
import type { AuthContext } from "../server";
import type { HelpReaderFactory } from "../services/help";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { createHelpRoutes } from "./help";

const authenticate = async (_c: unknown, next: () => Promise<void>) => next();
const help = fixtureHelpReader(async () => [
  {
    appId: "inventory",
    appName: "Inventory",
    manifestHash: "current",
    baseLocale: "en",
    documents: [{ id: "start", title: "Start", order: 10, markdown: '## Create {icon="plus"}\nHello <script>danger()</script>' }],
    documentsByLocale: { de: [{ id: "start", title: "Starten", order: 10, markdown: "## Erstellen\nHallo" }] },
  },
]);
describe("Help API", () => {
  test("mounts Help before capability middleware", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    expect(source.indexOf('.route("/", helpRoutes)')).toBeLessThan(source.indexOf('.route("/", capabilityRoutes)'));
  });
  test("uses the shared reader for search and safe article rendering", async () => {
    const routes = createHelpRoutes({ help, authenticate });
    expect(await (await routes.request("/help/v1/inventory/search?q=create")).json()).toEqual({ locale: "en", ids: ["start"] });
    const response = await routes.request("/help/v1/inventory/documents/start");
    expect(response.status).toBe(200);
    const article = await response.json();
    expect(article.html).not.toContain("<script>");
    expect(article.markdown).toContain("Hello");
  });
  test("resolves locales independently across requests", async () => {
    const routes = createHelpRoutes({ help, authenticate });
    const read = async (locale: string) =>
      (await routes.request("/help/v1/inventory/documents/start", { headers: { "x-cloud-locale": locale } })).json();
    expect(await read("de-CH")).toMatchObject({ locale: "de", title: "Starten" });
    expect(await read("en")).toMatchObject({ locale: "en", title: "Start" });
    expect((await routes.request("/help/v1/inventory/documents/missing")).status).toBe(404);
  });
  test("names untitled callouts in the document's language", async () => {
    const callouts = fixtureHelpReader(async () => [
      {
        appId: "inventory",
        appName: "Inventory",
        manifestHash: "current",
        baseLocale: "en",
        documents: [{ id: "start", title: "Start", order: 10, markdown: ":::warning\nBack up first.\n:::" }],
        documentsByLocale: { de: [{ id: "start", title: "Starten", order: 10, markdown: ":::warning\nErst sichern.\n:::" }] },
      },
    ]);
    const routes = createHelpRoutes({ help: callouts, authenticate });
    const read = async (locale: string) =>
      (await routes.request("/help/v1/inventory/documents/start", { headers: { "x-cloud-locale": locale } })).json();
    expect((await read("de-AT")).html).toContain('<span class="k2b-sr-only">Warnung: </span>');
    expect((await read("en")).html).toContain('<span class="k2b-sr-only">Warning: </span>');
  });
  test("refuses anonymous requests by default and reads as the signed-in viewer", async () => {
    const viewers: (RequestActor | undefined)[] = [];
    const recording: HelpReaderFactory = (locale, viewer) => {
      viewers.push(viewer);
      return help(locale, viewer);
    };
    const routes = createHelpRoutes({ help: recording });
    for (const path of ["/help/v1/inventory/search?q=create", "/help/v1/inventory/documents/start"]) {
      expect((await routes.request(path, { headers: { Accept: "application/json" } })).status).toBe(401);
    }
    expect(viewers).toEqual([]);

    const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: false });
    const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    try {
      const response = await routes.request("/help/v1/inventory/documents/start", {
        headers: { Accept: "application/json", Cookie: "session_token=test" },
      });
      expect(response.status).toBe(200);
      expect(viewers).toEqual([{ kind: "user", user }]);
    } finally {
      authenticate.mockRestore();
    }
  });
  test("needs the read scope from OAuth callers, like the other read APIs", async () => {
    const withScopes =
      (scopes?: string[]): MiddlewareHandler<AuthContext> =>
      async (c, next) => {
        if (scopes) c.set("oauthScopes", scopes);
        await next();
      };
    const status = async (scopes?: string[]) =>
      (await createHelpRoutes({ help, authenticate: withScopes(scopes) }).request("/help/v1/inventory/documents/start")).status;
    expect(await status(["openid", "profile"])).toBe(403);
    expect(await status(["read"])).toBe(200);
    expect(await status(["admin"])).toBe(200);
    expect(await status()).toBe(200);
  });
  test("rejects entry before reading and propagates outages", async () => {
    const routes = createHelpRoutes({ help, authenticate: async (c) => c.json({ error: "unauthorized" }, 401) });
    expect((await routes.request("/help/v1/inventory/search?q=test")).status).toBe(401);
    const failed = createHelpRoutes({
      authenticate,
      help: fixtureHelpReader(async () => {
        throw new Error("database unavailable");
      }),
    });
    expect((await failed.request("/help/v1/inventory/search?q=test")).status).toBe(500);
  });
});
