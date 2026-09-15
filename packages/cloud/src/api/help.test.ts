import { describe, expect, test } from "bun:test";
import { fixtureHelpReader } from "../../test/help-reader";
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
