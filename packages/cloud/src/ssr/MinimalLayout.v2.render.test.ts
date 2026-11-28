import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { PageOptions } from "../_internal/define-app";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(resolve(tmpdir(), "cloud-minimal-layout-v2-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { default: MinimalLayout } = await import("./MinimalLayout");
const options = {
  id: "fixture",
  name: "Fixture",
  icon: "ti ti-box",
  description: "Fixture",
  baseUrl: "http://fixture:3000",
  routes: ["/app/fixture"],
};
const app = defineApp(options);
type Environment = { Variables: { runtime: RuntimeContext; page: PageOptions } };
/** Through the app's real page template: the body carries what the template makes of the page's options. */
const server = new Hono<Environment>()
  .use(async (c, next) => {
    if (!c.req.query("bare"))
      c.set("runtime", { apps: [{ ...options, appearance: { accent: "#0f766e", primary: c.req.query("ai") ? "ai" : undefined } }] });
    await next();
  })
  .get(
    "/app/fixture/visit",
    ...app.ssr<Environment>(
      (c) => () =>
        createComponent(MinimalLayout, {
          c,
          ui: c.req.query("v1") ? undefined : "v2",
          get children() {
            return "A visitor's page";
          },
        }),
    ),
  );

const body = async (query = "") => {
  const html = await (await server.request(`/app/fixture/visit${query}`)).text();
  return html.match(/<body\b[^>]*>/)?.[0] ?? "";
};

test("a v2 visitor page speaks in its app's colour: the accent and both v2 inks on the body", async () => {
  const v2 = await body();
  expect(v2).toContain("app-accent-scope");
  expect(v2).toContain("--app-accent:#0f766e");
  expect(v2).toMatch(/--app-v2-ink-light:#[0-9a-f]{6};--app-v2-ink-dark:#[0-9a-f]{6}/);
  // the app's primary colour reaches the document too
  expect(await body("?ai=1")).toContain('data-k2b-primary="ai"');
});

test("without the runtime a v2 page keeps v2's own colour, and a v1 page stays as it was", async () => {
  expect(await body("?bare=1")).not.toContain("app-accent-scope");
  expect(await body("?v1=1")).not.toContain("app-accent-scope");
});
