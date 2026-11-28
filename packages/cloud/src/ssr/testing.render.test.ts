import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { PageOptions } from "../_internal/define-app";

const root = mkdtempSync(resolve(tmpdir(), "cloud-ssr-testing-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { default: MinimalLayout } = await import("./MinimalLayout");
const { withCoreStylesheet } = await import("./testing");

const app = defineApp({
  id: "fixture",
  name: "Fixture",
  icon: "ti ti-box",
  description: "Fixture",
  baseUrl: "http://fixture:3000",
  routes: ["/app/fixture"],
});
type Environment = { Variables: { page: PageOptions } };
/** A v2 visitor page through the app's real page template, which links the sheets the layout chose. */
const server = new Hono<Environment>().get(
  "/app/fixture/visit",
  ...app.ssr<Environment>(
    (c) => () =>
      createComponent(MinimalLayout, {
        c,
        ui: "v2",
        get children() {
          return "A visitor's page";
        },
      }),
  ),
);
const visit = async () => (await server.request("/app/fixture/visit")).text();

/** The frame beside a Core that serves v2.css: its sheet alone, the whole page one v2 scope, no inline frame. */
const expectServedSheet = (html: string) => {
  expect(html).toContain("/public/v2.css");
  expect(html).not.toContain("/public/global.css");
  expect(html).toContain('<div class="k2-ui minimal-layout" data-ui="v2">');
  expect(html).not.toContain("display:flex;flex-direction:column;min-height:100dvh");
};
/** The frame beside an older Core: its global.css and the frame inline. */
const expectOlderCore = (html: string) => {
  expect(html).toContain("/public/global.css");
  expect(html).not.toContain("/public/v2.css");
  expect(html).toContain("display:flex;flex-direction:column;min-height:100dvh");
};

test("a test process has no registered Core, so a v2 page renders the older Core's frame", async () => {
  expectOlderCore(await visit());
});

test("withCoreStylesheet renders a v2 page as a current Core serves it, then the older frame returns", async () => {
  expectServedSheet(await withCoreStylesheet(visit));
  expectOlderCore(await visit());
});

test("the previous state returns when the render throws, at once or after a pause", async () => {
  const thrown = await withCoreStylesheet(() => {
    throw new Error("fixture render failed");
  }).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(Error);
  expectOlderCore(await visit());

  const rejected = await withCoreStylesheet(async () => {
    expectServedSheet(await visit());
    throw new Error("fixture render failed later");
  }).catch((error: unknown) => error);
  expect(rejected).toBeInstanceOf(Error);
  expectOlderCore(await visit());
});

test("a nested call returns to the outer call's state", async () => {
  await withCoreStylesheet(async () => {
    await withCoreStylesheet(visit);
    expectServedSheet(await visit());
  });
  expectOlderCore(await visit());
});
