import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs } from "../../../ui/test/browser";
import { loadShellAssets, openShellPage, type ShellAssets } from "../../../ui/test/shell-page";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { proxyAuthService } from "../service";

// The real page in the Cloud shell, from invented clients: its first HTML with the shell's own stylesheets, fonts
// (Plex) and icons keeps the v2 layout rules at 1440 and 390 px. `CLOUD_PROXY_AUTH_SHELL_SHOTS=<dir>` also saves
// light pictures.
const root = mkdtempSync(join(tmpdir(), "proxy-auth-shell-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");
const shots = process.env.CLOUD_PROXY_AUTH_SHELL_SHOTS;

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
let assets: ShellAssets;
beforeAll(async () => {
  assets = await loadShellAssets({ id: "proxy-auth", css: resolve(import.meta.dir, "../styles/app.css") });
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
        const { context, tab, errors } = await openShellPage(browser, assets, { path: `/admin/proxy-auth${search}`, html, width });
        try {
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect({ name, width, problems: layout.problems }).toEqual({ name, width, problems: [] });
          if (shots) await tab.screenshot({ path: join(shots, `${name}-${width}.png`) });
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }, 300_000);
});
