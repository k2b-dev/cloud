import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { proxyAuthService } from "../service";

// The real page in the Cloud shell, from invented clients: its first HTML with the shell's own stylesheets and fonts
// keeps the v2 layout rules at 1440 and 390 px. `CLOUD_PROXY_AUTH_SHELL_SHOTS=<dir>` also saves light pictures.
const root = mkdtempSync(join(tmpdir(), "proxy-auth-shell-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const shots = process.env.CLOUD_PROXY_AUTH_SHELL_SHOTS;
const origin = "https://cloud.example.test";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["user", "admin"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Admin",
  displayName: "Ada Admin",
  mail: "admin@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const group = (id: number, name: string) => ({
  id: `00000000-0000-4000-8000-0000000000${String(id).padStart(2, "0")}`,
  name,
  provider: "local" as const,
});
const CLIENTS = {
  normal: [
    ["Grafana", "Dashboards der Werkstatt", [group(1, "betrieb"), group(2, "leitung")]],
    ["Paperless", "Belegablage", [group(3, "buchhaltung")]],
    ["Home Assistant", null, [group(4, "haustechnik")]],
    ["Uptime Kuma", "Erreichbarkeit der Dienste", []],
  ],
  worst: [
    [
      "Kunden & Aufträge (Werkstatt Nord) – interne Zeiterfassung und Materialbestellung",
      "Schützt die interne Zeiterfassung, die Materialbestellung und das Auftragsarchiv der Werkstatt Nord vor Zugriffen von außen",
      Array.from({ length: 9 }, (_, index) => group(10 + index, `werkstatt-nord-schicht-${index + 1}`)),
    ],
    ["X", null, []],
  ],
  empty: [],
} as const;

const clients = (data: keyof typeof CLIENTS) =>
  CLIENTS[data].map(([name, description, groups], index) => ({
    id: `00000000-0000-4000-8000-00000000000${index + 1}`,
    clientId: `pa_${name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60)}`,
    name,
    description,
    allowedGroups: [...groups],
    createdAt: `2026-11-${10 + index}T08:00:00.000Z`,
  }));

let browser: Browser;
let stylesheets: Record<string, string>;
let uiDist: string;
let iconFont: string;
beforeAll(async () => {
  uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  iconFont = /tabler-icons-[\w-]+\.woff2/.exec(icons)?.[0] ?? "";
  const build = async (entry: string) => {
    const result = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
    return result.outputs[0]!.text();
  };
  stylesheets = {
    "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
    "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
    "/public/global.css": await build(resolve(import.meta.dir, "../../../../styles.css")),
    "/public/proxy-auth/app.css": await build(resolve(import.meta.dir, "../styles/app.css")),
  };
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The first HTML of an address, as the page renders it for invented clients. */
const firstHtml = async (search: string, data: keyof typeof CLIENTS) => {
  const spies = [
    stubRailSnapshot(),
    spyOn(services, "get").mockResolvedValue("cloud.example.test" as never),
    spyOn(proxyAuthService.client, "list").mockResolvedValue({ items: clients(data) } as never),
  ];
  try {
    const app = new Hono<AuthContext & { Variables: { runtime: CloudRuntime } }>();
    app.use("*", async (c, next) => {
      c.set("actor", { kind: "user", user });
      c.set("user", user);
      c.set("runtime", { apps: [] });
      await next();
    });
    app.get("/admin/proxy-auth", ...handler);
    return await (await app.request(`/admin/proxy-auth${search}`, { headers: { "Accept-Language": "de" } })).text();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
};

describe("Proxy Auth in the Cloud shell", () => {
  test("the first picture keeps the v2 rules at 1440 and 390 px: list, open client, setup, empty and worst case", async () => {
    const cases: [string, string, keyof typeof CLIENTS][] = [
      ["liste", "", "normal"],
      ["client-offen", "?client=00000000-0000-4000-8000-000000000004", "normal"],
      ["einrichtung", "?tab=setup", "normal"],
      ["leer", "", "empty"],
      ["worst-case", "", "worst"],
      ["worst-case-offen", "?client=00000000-0000-4000-8000-000000000001", "worst"],
    ];
    for (const [name, search, data] of cases) {
      const html = await firstHtml(search, data);
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: width === 390 ? 844 : 900 },
          deviceScaleFactor: 1,
          isMobile: width === 390,
          hasTouch: width === 390,
          reducedMotion: "reduce",
          colorScheme: "light",
        });
        const tab = await context.newPage();
        const errors = pageErrors(tab);
        await tab.route(`${origin}/**`, async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname === "/admin/proxy-auth") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
          if (stylesheets[url.pathname]) return route.fulfill({ contentType: "text/css", body: stylesheets[url.pathname] });
          if (url.pathname === "/public/tabler-icons.woff2") return route.fulfill({ path: resolve(uiDist, iconFont) });
          if (url.pathname.startsWith("/public/fonts/")) {
            const fonts = resolve(uiDist, "fonts");
            const path = resolve(fonts, url.pathname.slice("/public/fonts/".length));
            return path.startsWith(`${fonts}/`) ? route.fulfill({ path }) : route.fulfill({ status: 404 });
          }
          // the islands stay as the server drew them: this is the first picture
          return route.fulfill({ status: 404, body: "" });
        });
        try {
          await tab.goto(`${origin}/admin/proxy-auth${search}`);
          await tab.evaluate(() => window.document.fonts.ready);
          await settled(tab);
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect({ name, width, problems: layout.problems }).toEqual({ name, width, problems: [] });
          if (shots) await tab.screenshot({ path: join(shots, `${name}-${width}.png`) });
          // only the islands' scripts may be missing here
          expect(errors.filter((error) => !/Failed to load|404|import/i.test(String(error)))).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);
});
