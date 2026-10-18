import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import type { PageOptions } from "../_internal/define-app";
import type { RuntimeAppMeta } from "../contracts/app";
import type { RailSnapshot } from "../contracts/rail-preferences";
import type { User } from "../contracts/shared";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(resolve(tmpdir(), "cloud-panel-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { default: Layout } = await import("./Layout");

type Environment = {
  Variables: {
    runtime: RuntimeContext;
    user: User | undefined;
    page: PageOptions;
    railPreferences: RailSnapshot;
    announcements: LayoutAnnouncementsState;
    settings: { app: { name: string } };
  };
};
const providers: RuntimeAppMeta[] = ["fixture", "second"].map((id) => ({
  id,
  name: id,
  icon: "ti ti-box",
  description: "Fixture",
  routes: [`/app/${id}`],
  panel: { href: `/app/${id}/panel?base=1`, label: `${id} panel`, icon: "ti ti-box" },
}));
const app = defineApp({
  id: "panel-render",
  name: "Panel render",
  icon: "ti ti-box",
  description: "Fixture",
  baseUrl: "http://panel-render:3000",
  routes: ["/app/fixture"],
});
const server = new Hono<Environment>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps: providers.slice(0, Number(c.req.query("providers") ?? 1)) });
    c.set("user", c.req.query("anonymous") === "true" ? undefined : person);
    c.set("settings", { app: { name: "Cloud" } });
    await next();
  })
  .get(
    "/app/fixture",
    ...app.ssr<Environment>(
      (c) => () =>
        createComponent(Layout, {
          c,
          title: "Fixture",
          panel: c.req.query("panel") === "false" ? false : undefined,
          focusMode: c.req.query("focus") === "true",
          children: "Application",
        }),
    ),
  );

async function render(query = "", cookie = "") {
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  ];
  try {
    const response = await server.request(`/app/fixture?${query}`, {
      headers: { Cookie: cookie, "Accept-Language": "en", "User-Agent": "Windows" },
    });
    expect(response.status).toBe(200);
    return response.text();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

test("SSR restores open panel and width in the normal canvas", async () => {
  const html = await render("", "cloud_panel=1:fixture:24");
  const canvas = html.match(/<div[^>]*class="cloud-app-canvas[^>]*>/)?.[0] ?? "";
  expect(canvas).toContain('data-panel="open"');
  expect(canvas).not.toContain("data-panel-transient");
  expect(canvas).toContain("--cloud-panel-width-set:24rem");
  expect(html).toMatch(/data-cloud-app-area(?:="")?[ >]/);
  expect(html).toContain('data-state="loading" data-provider="fixture"');
  expect(html).toMatch(/<iframe[^>]*src="\/app\/fixture\/panel\?base=1"[^>]*title="fixture panel"/);
  expect(html).toContain('data-cloud-panel-frame="fixture"');
  expect(html.match(/id="cloud-shell-data"/g)).toHaveLength(1);
  expect(html).toContain('aria-valuenow="24"');
});

test("focus pages start closed with transient panel state and retain the saved width", async () => {
  const html = await render("focus=true", "cloud_panel=1:fixture:24");
  const canvas = html.match(/<div[^>]*class="cloud-app-canvas[^>]*>/)?.[0] ?? "";
  expect(html).not.toContain('data-panel="open"');
  expect(canvas).toMatch(/data-panel-transient(?:="")?[ >]/);
  expect(canvas).toContain("--cloud-panel-width-set:24rem");
  expect(html).toContain('data-state="closed"');
  expect(html).not.toContain("<iframe");
  expect(html.match(/id="cloud-shell-data"/g)).toHaveLength(1);
});

test("closed panel has a title, no iframe, tabs or Panel trigger for a single provider", async () => {
  const html = await render();
  expect(html).toContain('id="cloud-panel"');
  expect(html).toContain('class="cloud-panel__title"');
  expect(html).toContain('data-state="closed"');
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain('role="tablist"');
  expect(html).not.toContain("data-cloud-panel-toggle");
});

test("two providers have tabs and rail/header triggers with SSR open state", async () => {
  const html = await render("providers=2", "cloud_panel=1:second:24");
  expect(html).toContain('role="tablist" aria-label="Panels"');
  expect(html).toContain('data-cloud-panel-provider="second" aria-selected="true"');
  const buttons = html.match(/<button[^>]*data-cloud-panel-toggle[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    expect(button).toContain('aria-expanded="true"');
    expect(button).toContain('aria-controls="cloud-panel"');
  }
  expect(html).toContain("Panel (Ctrl+J)");
  expect(html).not.toContain('class="cloud-panel__title"');
});

for (const query of ["panel=false", "providers=0", "anonymous=true"])
  test(`${query} renders no slot, provider data or Panel trigger`, async () => {
    for (const cookie of ["cloud_panel=1:fixture:24", "cloud_panel=0::24"]) {
      const html = await render(query, cookie);
      expect(html).not.toContain('id="cloud-panel"');
      expect(html).not.toContain("data-cloud-panel-toggle");
      expect(html).not.toContain('"panel":{');
      expect(html).not.toContain('data-panel="open"');
      expect(html).not.toContain("--cloud-panel-width-set");
    }
  });
