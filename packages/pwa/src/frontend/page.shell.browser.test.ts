import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeAppMeta, User } from "@k2b/cloud/contracts";
import { coreSettings, pwaDevices } from "@k2b/cloud/services";
import { announcements } from "@k2b/cloud/services/announcements";
import * as iconSource from "@k2b/cloud/services/branding/app-icon-source";
import * as staticAssets from "@k2b/cloud/services/pwa-assets";
import { session } from "@k2b/cloud/services/session";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs } from "../../../ui/test/browser";
import { loadShellAssets, openShellPage, type ShellAssets } from "../../../ui/test/shell-page";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// The app's pages on v2 in their real frame, from an invented account and phone: Start with its parts (and the worst
// case of many long ones), without parts, blocked and unavailable, and Settings keep the v2 layout rules at 390 px, the
// phone they are made for, and at 1440 px. `CLOUD_PWA_SHELL_SHOTS=<dir>` also saves light pictures.
const root = mkdtempSync(join(tmpdir(), "pwa-shell-pictures-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { shellRoutes } = await import("./index");
const shots = process.env.CLOUD_PWA_SHELL_SHOTS;

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@werkstatt.example",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const shell: RuntimeAppMeta = {
  id: "pwa",
  name: "Mobile app",
  icon: "ti ti-device-mobile",
  description: "",
  routes: ["/pwa", "/public/pwa"],
};
const part = (id: string, name: string, icon: string, description: string): RuntimeAppMeta => ({
  id,
  name,
  icon,
  description,
  routes: [`/pwa/${id}`],
  pwa: { href: `/pwa/${id}` },
});
const PARTS = [
  part("mail", "Mail", "ti ti-mail", "Posteingang der Werkstatt"),
  part("chat", "Chat", "ti ti-messages", "Team und Baustellen"),
  part("calendar", "Kalender", "ti ti-calendar", "Termine und Schichten"),
  part("files", "Dateien", "ti ti-folder", "Pläne, Fotos und Belege"),
  part("inventory", "Lager", "ti ti-box", "Bestand zählen und buchen"),
  part("tasks", "Aufgaben", "ti ti-checkbox", "Was heute ansteht"),
  part("notes", "Notizen", "ti ti-notes", "Eigene Notizen"),
];
const WORST = [
  ...PARTS,
  ...Array.from({ length: 12 }, (_, index) =>
    part(
      `standort-${index + 1}`,
      `Standortübergreifende Materialbestellung und Zeiterfassung Werkstatt Nord ${index + 1}`,
      "ti ti-building-warehouse",
      "Bestellungen, Lieferscheine und Stunden aller Schichten im Erdgeschoss, auch auf den Tablets in der Halle",
    ),
  ),
];

let apps: RuntimeAppMeta[] = [shell];
const settings: Record<string, string> = { "app.name": "Werkstatt Cloud", "app.locale": "de", "app.logo": "" };
const spies = [
  spyOn(staticAssets, "pwaStaticAssets").mockResolvedValue([]),
  stubRailSnapshot(),
  spyOn(session, "getToken").mockReturnValue(null),
  spyOn(session, "authenticateRequest").mockResolvedValue(null),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
  spyOn(coreSettings, "get").mockImplementation((async (key: string) => settings[key]) as never),
  spyOn(iconSource, "appIconVersion").mockResolvedValue("aaaaaaaaaaaa"),
  spyOn(pwaDevices, "current").mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
    name: "iPhone von Mia",
    platform: "ios",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: "2026-10-01T10:00:00.000Z",
    current: true,
  }),
];
const [, , tokenSpy, sessionSpy] = spies as unknown as [unknown, unknown, ReturnType<typeof spyOn>, ReturnType<typeof spyOn>];

const server = new Hono()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    c.set("settings" as never, { app: { name: settings["app.name"], locale: settings["app.locale"] } } as never);
    await next();
  })
  .route("/", shellRoutes);

/** The first HTML of an app page, signed in on this phone or not. */
const firstHtml = async (path: string, signedIn: boolean) => {
  tokenSpy.mockReturnValue(signedIn ? "test-session" : null);
  sessionSpy.mockResolvedValue(
    signedIn ? { user, data: { userId: user.id, sid: "test", authEpoch: 0, kind: "app", expiresAt: "2099-01-01T00:00:00Z" } } : null,
  );
  const response = await server.request(`https://cloud.example.test${path}`, {
    headers: { Cookie: "pwa_session=test-session; cloud.locale=de" },
  });
  expect(response.status, path).toBe(200);
  return response.text();
};

let browser: Browser;
let assets: ShellAssets;
beforeAll(async () => {
  assets = await loadShellAssets({ id: "pwa", css: resolve(import.meta.dir, "../styles/app.css") });
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

describe("The app on v2 in its frame", () => {
  test("Start, its empty, blocked and unavailable states and Settings keep the v2 rules at 390 and 1440 px", async () => {
    const cases: [name: string, path: string, parts: RuntimeAppMeta[], signedIn: boolean][] = [
      ["start", "/pwa/", PARTS, true],
      ["start-worst-case", "/pwa/", WORST, true],
      ["start-leer", "/pwa/", [], true],
      ["gesperrt", "/pwa/?pwa=blocked", PARTS, false],
      ["nicht-erreichbar", "/pwa/?pwa=unavailable", PARTS, false],
      ["einstellungen", "/pwa/settings", PARTS, true],
    ];
    for (const [name, path, parts, signedIn] of cases) {
      apps = [shell, ...parts];
      const html = await firstHtml(path, signedIn);
      for (const width of [390, 1440]) {
        const { context, tab, errors } = await openShellPage(browser, assets, { path, html, width });
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
