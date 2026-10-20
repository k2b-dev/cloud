import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import type { User } from "../contracts/shared";
import type { RuntimeContext } from "./runtime";

// Only pre-pageSwap APIs: the owner can regenerate these exact snapshots on origin/main.
// Relative island ids and frozen request data make the HTML portable between checkouts.
setSystemTime(new Date("2026-10-01T12:00:00Z"));
const uuid = spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
const { plugin } = createConfig({ dev: true, rootDir: resolve(import.meta.dir, "../.."), componentRoots: [] });
Bun.plugin(plugin());
const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const { default: Layout } = await import("./Layout");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const consent = await import("./panel-consent");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const spies = [
  spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
  spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
  spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  spyOn(consent, "preloadPanelConsent").mockResolvedValue(undefined),
];
const app = defineApp({
  id: "unchanged",
  name: "Unchanged",
  icon: "ti ti-box",
  description: "Snapshot fixture",
  baseUrl: "http://unchanged:3000",
  routes: ["/app/unchanged"],
});
type Env = { Variables: { runtime: RuntimeContext; user: User | undefined } };
const server = new Hono<Env>()
  .use(async (c, next) => {
    c.set("runtime", {
      apps: [
        {
          ...app.meta,
          panel: { href: "/app/unchanged/panel", label: "Panel", icon: "ti ti-box" },
          nav: { href: "/app/unchanged", section: "primary" },
        },
      ],
    });
    if (c.req.query("mode") !== "anonymous") c.set("user", person);
    await next();
  })
  .get(
    "/app/unchanged",
    ...app.ssr<Env>(
      (c) => () =>
        createComponent(Layout, {
          c,
          title: "Unchanged page",
          fullPage: c.req.query("mode") === "fullPage",
          fullWidth: c.req.query("mode") === "fullWidth",
          focusMode: c.req.query("mode") === "focusMode",
          children: "Page content",
        }),
    ),
  );
for (const mode of ["regular", "fullPage", "fullWidth", "focusMode", "anonymous"]) {
  test(`opt-out ${mode} HTML is unchanged`, async () => {
    const response = await server.request(`/app/unchanged?mode=${mode}`);
    expect(response.status).toBe(200);
    // Trailing spaces become "·" so the exact bytes stay visible in the snapshot file without trailing whitespace.
    expect((await response.text()).replace(/ +$/gm, (spaces) => "·".repeat(spaces.length))).toMatchSnapshot();
  });
}
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  uuid.mockRestore();
  setSystemTime();
});
