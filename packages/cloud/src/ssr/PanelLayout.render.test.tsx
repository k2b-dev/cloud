import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import type { PageOptions } from "../_internal/define-app";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(resolve(tmpdir(), "cloud-panel-layout-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { default: PanelLayout } = await import("./PanelLayout");
const { useLocale } = await import("@k2b/ui");
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
const Child = () => `Inherited locale: ${useLocale()()}`;
const server = new Hono<Environment>()
  .use(async (c, next) => {
    // A trailing slash is a valid declaration; the gateway and the panel check read it canonically.
    c.set("runtime", { apps: [{ ...options, routes: c.req.query("slash") ? ["/app/fixture/"] : options.routes }] });
    await next();
  })
  .get(
    "/app/fixture/panel",
    ...app.ssr<Environment>(
      (c) => () =>
        createComponent(PanelLayout, {
          c,
          title: "Fixture lookup",
          get children() {
            return createComponent(Child, {});
          },
        }),
    ),
  );

for (const locale of ["en", "de"])
  test(`PanelLayout has one runtime, provider, title, theme and inherited ${locale} locale`, async () => {
    const response = await server.request("/app/fixture/panel", { headers: { "Accept-Language": locale, Cookie: "theme=dark" } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<title>Fixture lookup</title>");
    expect(html).toContain(`lang="${locale}" class="dark"`);
    expect(html).toMatch(/class="cloud-panel-page" data-cloud-panel-page(?:="")? data-panel-provider="fixture"/);
    expect(html).toContain(`Inherited locale: ${locale}`);
    expect(html.match(/<solid-island\b/g)).toHaveLength(1);
    expect(html).toContain("PanelRuntime");
    for (const absent of [
      "ShellRuntime",
      "layout-rail",
      "layout-header",
      "layout-footer",
      "cloud-panel__card",
      "cloud-shell-data",
      "cloud-announcement",
    ])
      expect(html).not.toContain(absent);
  });

test("PanelLayout names its provider when the app declares its route with a trailing slash", async () => {
  const response = await server.request("/app/fixture/panel?slash=1");
  expect(await response.text()).toMatch(/data-panel-provider="fixture"/);
});
