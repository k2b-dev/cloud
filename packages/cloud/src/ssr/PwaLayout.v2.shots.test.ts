import { afterAll, beforeAll, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as watcher from "../_internal/runtime-watcher";
import type { RuntimeAppMeta } from "../contracts/app";
import type { User } from "../contracts/shared";
import { type AuthContext, auth } from "../server/middleware/auth";
import { announcements } from "../services/announcements";
import { session } from "../services/session";
import * as badges from "./app-badges";
import { pwaMessages } from "./pwa-messages";

// Only on request (`CLOUD_SHOTS=1 bun test <this file>`): the suite skips it.
const shots = process.env.CLOUD_SHOTS !== undefined;

// Design-review images of `PwaLayout ui="v2"` (not part of the suite; see `shots` below): invented content, light, real fonts and icons,
// the phone with a notch and a home indicator. Writes PNGs to `pwa-shots/` at the repository root.
const root = mkdtempSync(join(tmpdir(), "cloud-pwa-shots-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { default: PwaLayout } = await import("./PwaLayout");
const { Button, Chip, Digest, Facts, Notice, Pane, Progress, Row, Section, StatusRow, Text } = await import("@k2b/ui/v2");

const { ssr } = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Invented",
  baseUrl: "http://inventory:3000",
  routes: [],
  pwa: {},
});

/** Invented demo account. */
const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.org",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};
const part = (id: string, name: string, icon: string, pwa: { badge?: boolean; summary?: boolean } = {}): RuntimeAppMeta => ({
  id,
  name,
  icon: `ti ti-${icon}`,
  description: "",
  routes: [`/pwa/${id}`],
  pwa: {
    href: `/pwa/${id}`,
    ...(pwa.badge ? { badge: `/pwa/${id}/unread` } : {}),
    ...(pwa.summary ? { summary: `/pwa/${id}/summary` } : {}),
  },
});
const apps: RuntimeAppMeta[] = [
  { id: "pwa", name: "Cloud app", icon: "ti ti-device-mobile", description: "", routes: ["/pwa"] },
  part("chat", "Chat", "messages", { badge: true }),
  part("mail", "Mail", "mail", { badge: true }),
  part("spaces", "Spaces", "layout-kanban", { summary: true }),
  part("files", "Dateien", "folder"),
  part("notebooks", "Notizbücher", "notebook"),
];
const counts: Record<string, number> = { "/pwa/chat/unread": 3, "/pwa/mail/unread": 12, "/pwa/spaces/summary": 5 };

const spies = [
  stubRailSnapshot(),
  spyOn(session, "getToken").mockReturnValue("test-session"),
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "app", expiresAt: "2099-01-01T00:00:00Z" },
  }),
  spyOn(announcements.active, "forState").mockResolvedValue({ banners: [], announcements: [], latestAnnouncementVersion: 0 }),
  spyOn(watcher, "registeredCoreRoutes").mockReturnValue(["/public/global.css", "/public/v2.css"]),
  // The counts as the browser reads them a moment after the page arrives.
  spyOn(badges, "appBadgeCount").mockImplementation((input) => (input.endpoint ? (counts[input.endpoint] ?? 0) : 0)),
];

const row = (props: Parameters<typeof Row>[0]) => createComponent(Row, props);
const section = (props: Omit<Parameters<typeof Section>[0], "children">, rows: () => unknown[]) =>
  createComponent(Section, {
    ...props,
    get children() {
      return rows();
    },
  } as Parameters<typeof Section>[0]);

// Start says what waits for the person, not which apps exist (the sidebar and the tabs list them): what is new for
// them with who sent it, today's dates, this device; beside it on a wide screen, the activity of the people around.
// One signal per row: an avatar or a mark leads, a chip only where something asks to act.
const forYou = () =>
  section({ icon: "inbox", color: "#2563eb", title: "Für dich", count: 4 }, () => [
    row({
      avatar: { name: "Jonas Becker", color: "#be123c" },
      lines: ["Jonas Becker in Team Programm", "Reichen 80 Stühle für Samstag im Großen Saal?"],
      time: "09:41",
      end: createComponent(Chip, { children: "3 neu" }),
      href: "/pwa/chat",
    }),
    row({
      avatar: { name: "Kasse Lindenhof", color: "#2563eb" },
      lines: ["Kasse: Abrechnung November", "Bitte bis Freitag die Belege der Werkstatt freigeben."],
      time: "10:12",
      end: createComponent(Chip, { status: "warn", icon: "clock", children: "Fr fällig" }),
      href: "/pwa/mail",
    }),
    row({
      avatar: { name: "Mara Okafor", color: "#be185d" },
      lines: ["Plakate Dezember aufhängen", "Spaces · Mara Okafor hat es dir zugewiesen"],
      end: createComponent(Chip, { status: "bad", icon: "alert-triangle", children: "heute" }),
      href: "/pwa/spaces",
    }),
    row({
      avatar: { name: "Ali Demir", color: "#b45309" },
      lines: ["Programm Dezember.pdf", "Dateien · Ali Demir hat es dir freigegeben"],
      time: "gestern",
      href: "/pwa/files",
    }),
  ]);

const today = () => [
  section({ icon: "calendar", color: "#15803d", title: "Heute", count: 3 }, () => [
    row({ avatar: { name: "Mia Muster", color: "#be185d" }, lines: ["Teamrunde Programm", "10:00–10:45 · Saal 2"], time: "10:00" }),
    row({ avatar: { name: "Ali Demir", color: "#b45309" }, lines: ["Offene Holzwerkstatt", "14:00–17:00 · Werkraum"], time: "14:00" }),
    row({
      avatar: { name: "Dr. Henrike Vogt", color: "#7c3aed" },
      lines: ["Lesung: Der Lindenhof 1920–1960", "18:30 · Saal 2"],
      time: "18:30",
    }),
  ]),
];

// What the people around did, as sentences with who and what: the side column of a wide screen, full, not decoration.
const activity = () =>
  createComponent(Digest, {
    label: "Aktivität",
    get children() {
      return [
        row({
          avatar: { name: "Clara Weiß", color: "#0e7490" },
          lines: ["Clara Weiß", "meldete Kammermusik als ausgebucht"],
          time: "11:02",
        }),
        row({
          avatar: { name: "Ali Demir", color: "#b45309" },
          lines: ["Ali Demir", "teilte Programm Dezember.pdf"],
          time: "10:47",
        }),
        row({
          avatar: { name: "Olena Koval", color: "#15803d" },
          lines: ["Olena Koval", "bestätigte 6 Anmeldungen"],
          time: "10:30",
        }),
        row({
          avatar: { name: "Jonas Becker", color: "#be123c" },
          lines: ["Jonas Becker", "schrieb 3 Nachrichten in Programm"],
          time: "09:41",
        }),
        row({
          avatar: { name: "Mara Okafor", color: "#be185d" },
          lines: ["Mara Okafor", "verlegte die Werkstatt auf Freitag"],
          time: "gestern",
        }),
        row({
          avatar: { name: "Dr. Henrike Vogt", color: "#7c3aed" },
          lines: ["Dr. Henrike Vogt", "erweiterte die Lesung um 2 Plätze"],
          time: "gestern",
        }),
      ];
    },
  });

const start = () =>
  createComponent(Pane.Split, {
    get children() {
      return [
        createComponent(Pane, {
          label: "Start",
          get children() {
            return [forYou(), ...today()];
          },
        }),
        createComponent(Pane, {
          side: true,
          label: "Aktivität",
          width: { fixed: 320 },
          get children() {
            return section({ icon: "activity", color: "#64748b", title: "Aktivität" }, () => [activity()]);
          },
        }),
      ];
    },
  });

// the first line says what counts today, as the rows below show it
const status = () => createComponent(StatusRow, { lead: "Heute: 15 ungelesen · 1 fällig" });

// This device first: its sign-out is the one deed a phone must reach without scrolling.
const settingsMain = () => [
  section({ icon: "device-mobile", color: "#64748b", title: "Dieses Gerät" }, () => [
    row({
      icon: "device-mobile",
      color: "#64748b",
      lines: ["Pixel 9 von Mia Muster", "Gekoppelt seit 12. November · aktiv"],
      action: { label: "Abmelden", icon: "logout" },
    }),
  ]),
  section({ icon: "user", color: "#be185d", title: "Konto" }, () => [
    row({ avatar: { name: "Mia Muster", color: "#be185d" }, lines: ["Mia Muster", "mia.muster@example.org"] }),
  ]),
  section({ icon: "palette", color: "#7c3aed", title: "Darstellung" }, () => [
    row({
      icon: "sun-moon",
      color: "#7c3aed",
      lines: ["Erscheinungsbild", "Folgt dem Gerät"],
      end: createComponent(Text, { muted: true, children: "Automatisch" }),
    }),
    row({
      icon: "language",
      color: "#7c3aed",
      lines: ["Sprache", "Wie im Browser"],
      end: createComponent(Text, { muted: true, children: "Deutsch" }),
    }),
  ]),
  section({ icon: "bell", color: "#0e7490", title: "Mitteilungen", count: 5 }, () => [
    row({
      icon: "messages",
      color: "#0e7490",
      lines: ["Chat", "Neue Nachrichten und Erwähnungen"],
      end: createComponent(Text, { muted: true, children: "An" }),
    }),
    row({
      icon: "mail",
      color: "#2563eb",
      lines: ["Mail", "Nur markierte Absender"],
      end: createComponent(Text, { muted: true, children: "An" }),
    }),
    row({
      icon: "layout-kanban",
      color: "#b45309",
      lines: ["Spaces", "Fällige Aufgaben am Morgen"],
      end: createComponent(Text, { muted: true, children: "Aus" }),
    }),
    row({
      icon: "notebook",
      color: "#7c3aed",
      lines: ["Notizbücher", "Wenn dich jemand erwähnt"],
      end: createComponent(Text, { muted: true, children: "An" }),
    }),
    row({
      icon: "folder",
      color: "#b45309",
      lines: ["Dateien", "Freigaben an dich"],
      end: createComponent(Text, { muted: true, children: "Aus" }),
    }),
  ]),
];

const settingsSide = () => [
  section({ icon: "devices", color: "#64748b", title: "Weitere Geräte", count: 2 }, () => [
    row({ icon: "device-ipad", color: "#64748b", lines: ["iPad Küche", "Zuletzt vor 3 Tagen"] }),
    row({ icon: "device-laptop", color: "#64748b", lines: ["Laptop Büro", "Zuletzt gestern"] }),
  ]),
  section({ icon: "database", color: "#15803d", title: "Auf diesem Gerät" }, () => [
    row({
      icon: "database",
      color: "#15803d",
      lines: ["Speicher", "Skripte und Stile der Apps"],
      end: createComponent(Progress, { value: 12, of: 16, label: "12/16 MB" }),
    }),
    row({
      icon: "pencil",
      color: "#15803d",
      lines: ["Entwürfe", "2 ungesendete Nachrichten"],
      end: createComponent(Text, { muted: true, children: "2" }),
    }),
  ]),
  section({ icon: "lifebuoy", color: "#0e7490", title: "Hilfe und Rechtliches" }, () => [
    row({ icon: "help", color: "#0e7490", lines: ["Hilfe", "Anleitungen für die App"], href: "/help" }),
    row({ icon: "file-text", color: "#64748b", lines: ["Impressum", "Kulturhaus Lindenhof e. V."], href: "/impressum" }),
    row({ icon: "shield-lock", color: "#64748b", lines: ["Datenschutz", "Was die App speichert"], href: "/datenschutz" }),
  ]),
  section({ icon: "info-circle", color: "#64748b", title: "Über" }, () => [
    createComponent(Facts, {
      items: [
        { label: "Installation", value: "Lindenhof Cloud" },
        { label: "Version", value: "0.71.0" },
      ],
    }),
  ]),
];

// Settings on a wide screen: the settings beside this device; on the phone one below the other.
// k2b-ui gap: Setting (#4223): the narrow column for settings stands in until `Setting` is on main.
const settings = () =>
  createComponent(Pane.Split, {
    get children() {
      return [
        createComponent(Pane, {
          label: "Einstellungen",
          get children() {
            return settingsMain();
          },
        }),
        createComponent(Pane, {
          side: true,
          label: "Geräte und Daten",
          width: { fixed: 320 },
          get children() {
            return settingsSide();
          },
        }),
      ];
    },
  });

const server = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    c.set("settings" as never, { app: { name: "Lindenhof Cloud" } } as never);
    await next();
  })
  .get(
    "/pwa/",
    auth.requireRole("*"),
    ...ssr<AuthContext>(
      (c) => () =>
        createComponent(PwaLayout, {
          c,
          ui: "v2",
          title: "Lindenhof Cloud",
          sidebarTitle: "Start",
          get status() {
            return status();
          },
          get children() {
            return start();
          },
        }),
    ),
  )
  .get(
    "/pwa/settings",
    auth.requireRole("*"),
    ...ssr<AuthContext>(
      (c) => () =>
        createComponent(PwaLayout, {
          c,
          ui: "v2",
          title: "Einstellungen",
          // no part's place: a screen of its own with the way back to Start
          screen: true,
          // beside the sidebar, its marked entry already says where the page stands
          back: { href: "/pwa/", label: "Start", withSidebar: false },
          get children() {
            return settings();
          },
        }),
    ),
  );

const t = pwaMessages.resolve(["de"]).t;
const notices = {
  offline: () =>
    renderToString(() =>
      createComponent(Notice, {
        tone: "warn",
        icon: "wifi-off",
        actions: [{ label: t.hide, onClick: () => {} }],
        children: t.offlineConsequence,
      }),
    ),
  update: () =>
    renderToString(() =>
      createComponent(Notice, {
        tone: "info",
        icon: "refresh",
        actions: [
          { label: t.reload, icon: "refresh", onClick: () => {} },
          { label: t.hide, onClick: () => {} },
        ],
        children: t.newVersion({ cloud: "Lindenhof Cloud" }),
      }),
    ),
};

const origin = "https://cloud.example.org";
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#9a3412"/><path d="M18 46V18h7v22h15v6z" fill="#fff"/><circle cx="44" cy="22" r="5" fill="#fdba74"/></svg>';
const repo = resolve(import.meta.dir, "../../../..");
const ui = resolve(repo, "packages/ui/dist");
const out = resolve(repo, "pwa-shots");
const insets = { top: 47, right: 0, bottom: 34, left: 0 };
let browser: Browser;
let css = "";
beforeAll(async () => {
  if (!shots) return;
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/v2-page.css")] });
  if (!build.success) throw new AggregateError(build.logs, "Could not build v2.css.");
  css = await build.outputs[0]!.text();
  mkdirSync(out, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  for (const spy of spies) spy.mockRestore();
});

const shoot = async (name: string, path: string, width: number, notice?: keyof typeof notices) => {
  const phone = width < 768;
  const response = await server.request(`${origin}${path}`, {
    headers: { Cookie: "pwa_session=test-session; theme=light; cloud.locale=de", "Accept-Language": "de" },
  });
  const body = await response.text();
  // A phone has its notch and home indicator; a desktop engine has none, so the sheet takes them as fixed sizes.
  const sheet = phone
    ? css.replace(/env\(\s*safe-area-inset-(top|right|bottom|left)\s*\)/g, (_, side: keyof typeof insets) => `${insets[side]}px`)
    : css;
  const page = await browser.newPage({
    colorScheme: "light",
    viewport: { width, height: phone ? 844 : 900 },
    deviceScaleFactor: 2,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === path) return route.fulfill({ contentType: "text/html", body });
    if (url.pathname === "/public/v2.css") return route.fulfill({ contentType: "text/css", body: sheet });
    // an invented installation's logo
    if (url.pathname === "/branding/logo") return route.fulfill({ contentType: "image/svg+xml", body: LOGO });
    if (url.pathname === "/public/fonts.css") return route.fulfill({ contentType: "text/css", body: readFileSync(join(ui, "plex.css")) });
    if (url.pathname === "/public/tabler-icons.css")
      return route.fulfill({ contentType: "text/css", body: readFileSync(join(ui, "tabler.css")) });
    if (url.pathname.startsWith("/public/fonts/"))
      return route.fulfill({ contentType: "font/woff2", body: readFileSync(join(ui, "fonts", url.pathname.slice(14))) });
    if (/^\/public\/tabler-icons-[\w]+\.woff2$/.test(url.pathname))
      return route.fulfill({ contentType: "font/woff2", body: readFileSync(join(ui, url.pathname.slice(8))) });
    return route.fulfill({ status: 204 });
  });
  try {
    await page.goto(`${origin}${path}`);
    if (notice) {
      const html = notices[notice]();
      await page.evaluate((markup) => {
        document.querySelector("[data-k2-part='NoticeStack']")!.innerHTML = markup;
      }, html);
      // what the stack does once its island runs: the panes keep the room it covers; the offline picture shows the end
      // the page as it opens: the notice floats over it, the panes keep its room at their end (the browser test scrolls)
      await page.evaluate(() => {
        const stack = document.querySelector("[data-k2-part='NoticeStack']")!;
        const bar = document.querySelector<HTMLElement>(".k2-tabbar");
        const covered = innerHeight - stack.getBoundingClientRect().top - (bar?.offsetHeight ?? 0);
        document.documentElement.style.setProperty("--k2-notice-stack", `${Math.ceil(covered)}px`);
      });
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await settled(page);
    await page.screenshot({ path: join(out, `${name}-${width}.png`) });
  } finally {
    await page.close();
  }
};

for (const width of [390, 1024, 1440]) {
  test.skipIf(!shots)(`start ${width}`, () => shoot("start", "/pwa/", width), 60_000);
  test.skipIf(!shots)(`settings ${width}`, () => shoot("settings", "/pwa/settings", width), 60_000);
  test.skipIf(!shots)(`offline ${width}`, () => shoot("offline", "/pwa/", width, "offline"), 60_000);
  test.skipIf(!shots)(`update ${width}`, () => shoot("update", "/pwa/", width, "update"), 60_000);
}
