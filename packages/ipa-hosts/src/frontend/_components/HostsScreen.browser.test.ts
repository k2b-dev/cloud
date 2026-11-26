import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import { loadShellAssets, type ShellAssets } from "../../../../ui/test/shell-page";

// Hosts on v2, from invented hosts: the screen keeps the v2 layout rules at desktop, tablet and phone width with normal,
// worst-case and no data; a group and a host open beside the list, and their deeds ask before they change anything.
// `CLOUD_IPA_HOSTS_V2_SHOTS=<dir>` also saves a light screenshot per view, data set and width.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_IPA_HOSTS_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "HostsScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-ipa-hosts-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Hosts harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let harness: string;
let assets: ShellAssets;
beforeAll(async () => {
  harness = await buildHarness();
  // the shell's own stylesheets, Plex fonts and icons, as the page loads them
  assets = await loadShellAssets({ id: "ipa-hosts", css: resolve(import.meta.dir, "../../styles/app.css") });
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const document = (state: string) =>
  `<!doctype html><html lang="de" class="light" data-state="${state}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1">${assets.head}` +
  `<style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const tablet: View = { width: 1024, height: 800, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

/** How the API answers: `fail` names requests ("METHOD path" plus the group of a body) that fail, each only `times` often. */
type Failures = { request: string; times: number }[];

const open = async (view: View, address: string, state = "normal", failures: Failures = []) => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const left = failures.map((failure) => ({ ...failure }));
  // nothing leaves the test origin
  await context.route("**", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (url.pathname === "/admin/ipa-hosts") return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(state) });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (await assets.serve(route, url)) return;
    const method = route.request().method();
    if (url.pathname === "/api/ipa-hosts/hostgroups/search")
      return route.fulfill({
        json: {
          hostgroups: [
            { cn: "drucker", description: "Drucker und Scanner" },
            { cn: "kameras", description: null },
          ].filter((group) => !(url.searchParams.get("exclude") ?? "").split(",").includes(group.cn)),
        },
      });
    if (url.pathname.startsWith("/api/ipa-hosts")) {
      const body = method === "GET" ? null : route.request().postDataJSON();
      const request = `${method} ${url.pathname}${body && typeof body === "object" && "hostgroup" in body ? ` ${body.hostgroup}` : ""}`;
      if (method !== "GET") {
        calls.push(request);
        bodies.push(body);
      }
      const failure = left.find((candidate) => candidate.request === request && candidate.times > 0);
      if (failure) {
        failure.times -= 1;
        return route.fulfill({ status: 503, json: { message: "Unavailable" } });
      }
      if (url.pathname === "/api/ipa-hosts/settings/sync-cron" && method === "GET")
        return route.fulfill({ json: { cron: "*/5 * * * *", timezone: "Europe/Berlin" } });
      return route.fulfill({ json: { message: "ok" } });
    }
    return route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>elsewhere</title>" });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, calls, bodies };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("Hosts on v2", () => {
  test("the screen keeps the v2 rules at 1440, 1024 and 390 px, with normal, worst-case and no data", async () => {
    const LONG = "kunden-und-auftraege-werkstatt-nord-zeiterfassung-und-materialbestellung-01.intern.werkstatt-nord.example";
    const cases: [string, string, string, View][] = [
      ["groups", "normal", "", desktop],
      ["groups", "normal", "", tablet],
      ["groups", "normal", "", phone],
      ["groups", "worst", "", desktop],
      ["groups", "worst", "", phone],
      ["groups", "empty", "", desktop],
      ["ungrouped", "normal", "?tab=ungrouped", desktop],
      ["ungrouped", "worst", "?tab=ungrouped", phone],
      ["group", "normal", "?group=server", desktop],
      ["group", "worst", "?group=werkstatt-nord-schichtbetrieb-maschinen-und-messplaetze-im-erdgeschoss", phone],
      ["host", "normal", "?group=server&host=db1.werkstatt.example", desktop],
      ["host", "worst", `?host=${LONG}`, desktop],
      ["host", "worst", `?host=${LONG}`, phone],
      ["gone", "normal", "?host=weg.werkstatt.example", desktop],
    ];
    for (const [view, state, search, size] of cases) {
      const name = `hosts-${view}-${state}-${size.width}`;
      const { context, tab, errors } = await open(size, `/admin/ipa-hosts${search}`, state);
      try {
        const outline = await describeV2Page(tab, "#root");
        expect({ name, problems: outline.includes("Problems (") ? outline : "" }).toEqual({ name, problems: "" });
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ name, problems: layout.problems }).toEqual({ name, problems: [] });
        await shoot(tab, name);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 300_000);

  const host = "/admin/ipa-hosts?group=server&host=db1.werkstatt.example";
  const closed = (tab: Page) => tab.waitForFunction(() => !window.document.querySelector('[role="dialog"], [role="alertdialog"]'));

  test("a host is edited with its MAC addresses checked before anything is sent", async () => {
    const { context, tab, errors, calls, bodies } = await open(desktop, host);
    try {
      await tab.getByRole("button", { name: "Bearbeiten" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("button", { name: "MAC-Adresse hinzufügen" }).click();
      await dialog.getByRole("textbox", { name: "MAC-Adresse 3" }).fill("kein-mac");
      await dialog.getByRole("button", { name: "Speichern" }).click();
      expect(await dialog.innerText()).toContain("AA:BB:CC:DD:EE:FF");
      expect(calls).toEqual([]);
      await shoot(tab, "dialog-host-bearbeiten-1440");
      await dialog.getByRole("textbox", { name: "MAC-Adresse 3" }).fill("aa-bb-cc-00-00-99");
      await dialog.getByRole("button", { name: "Speichern" }).click();
      await closed(tab);
      expect(calls).toEqual(["PATCH /api/ipa-hosts/db1.werkstatt.example"]);
      expect(bodies[0]).toMatchObject({ macAddress: ["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:99"] });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("adding a host to two groups names the one that failed and sends only it again", async () => {
    const { context, tab, errors, calls } = await open(desktop, host, "normal", [
      { request: "POST /api/ipa-hosts/db1.werkstatt.example/hostgroups kameras", times: 2 },
    ]);
    try {
      await tab.getByRole("button", { name: "Zu Hostgruppe hinzufügen" }).first().click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("searchbox").fill("a");
      await dialog.getByRole("option", { name: /drucker/ }).click();
      await dialog.getByRole("option", { name: /kameras/ }).click();
      await dialog.getByRole("button", { name: "Hinzufügen" }).click();
      await dialog.getByText("Nicht zu kameras hinzugefügt").waitFor();
      await shoot(tab, "dialog-gruppen-teilweise-1440");
      // the search no longer offers the group the host was added to
      const search = tab.waitForRequest((request) => request.url().includes("/hostgroups/search"));
      await dialog.getByRole("searchbox").fill("ka");
      expect(new URL((await search).url()).searchParams.get("exclude")?.split(",")).toContain("drucker");
      await settled(tab);
      expect(await dialog.getByRole("option", { name: /drucker/ }).count()).toBe(0);
      expect(calls).toEqual([
        "POST /api/ipa-hosts/db1.werkstatt.example/hostgroups drucker",
        "POST /api/ipa-hosts/db1.werkstatt.example/hostgroups kameras",
      ]);
      // again: only the group that failed
      await dialog.getByRole("button", { name: "Hinzufügen" }).click();
      await tab.waitForFunction(() => window.document.body.innerText.includes("Nicht zu kameras hinzugefügt"));
      expect(calls.slice(2)).toEqual(["POST /api/ipa-hosts/db1.werkstatt.example/hostgroups kameras"]);
      // closing after a success shows the result
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await tab.waitForSelector('body[data-ready="true"]');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("removing from a group and deleting a host ask first and send only when agreed; a failed delete offers a retry", async () => {
    const { context, tab, errors, calls } = await open(desktop, host, "normal", [
      { request: "DELETE /api/ipa-hosts/db1.werkstatt.example", times: 1 },
    ]);
    try {
      await tab.getByRole("button", { name: "Aus Gruppe entfernen" }).first().click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Abbrechen" }).click();
      expect(calls).toEqual([]);
      await tab.getByRole("button", { name: "Aus Gruppe entfernen" }).first().click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Entfernen" }).click();
      await tab.waitForFunction(() => window.document.body.dataset.ready === "true");
      expect(calls).toEqual(["DELETE /api/ipa-hosts/db1.werkstatt.example/hostgroups server"]);
    } finally {
      await context.close();
    }
    const deleting = await open(desktop, host, "normal", [{ request: "DELETE /api/ipa-hosts/db1.werkstatt.example", times: 1 }]);
    try {
      await deleting.tab.getByRole("button", { name: "Löschen" }).click();
      await deleting.tab.getByRole("alertdialog").getByRole("button", { name: "Abbrechen" }).click();
      expect(deleting.calls).toEqual([]);
      await deleting.tab.getByRole("button", { name: "Löschen" }).click();
      await deleting.tab.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
      // the store refused once: the toast offers the deed again
      await deleting.tab.getByRole("button", { name: "Erneut versuchen" }).click();
      await deleting.tab.waitForURL((url) => !url.search.includes("host="));
      expect(deleting.calls).toEqual(["DELETE /api/ipa-hosts/db1.werkstatt.example", "DELETE /api/ipa-hosts/db1.werkstatt.example"]);
      expect([...errors, ...deleting.errors]).toEqual([]);
    } finally {
      await deleting.context.close();
    }
  }, 60_000);

  test("a host group is created, edited and deleted, each with its own request", async () => {
    const { context, tab, errors, calls, bodies } = await open(desktop, "/admin/ipa-hosts");
    try {
      await tab.getByRole("button", { name: "Neue Hostgruppe" }).first().click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name" }).fill("werkstatt-sued");
      await dialog.getByRole("textbox", { name: "Beschreibung" }).fill("Neue Halle");
      await shoot(tab, "dialog-neue-gruppe-1440");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.waitForURL(/group=werkstatt-sued/);
      expect(calls).toEqual(["POST /api/ipa-hosts/hostgroups"]);
      expect(bodies[0]).toEqual({ name: "werkstatt-sued", description: "Neue Halle" });
    } finally {
      await context.close();
    }
    const group = await open(desktop, "/admin/ipa-hosts?group=server");
    try {
      await group.tab.getByRole("button", { name: "Bearbeiten" }).click();
      await group.tab.getByRole("dialog").getByRole("textbox", { name: "Beschreibung" }).fill("Rechenraum, Keller");
      await group.tab.getByRole("dialog").getByRole("button", { name: "Speichern" }).click();
      await closed(group.tab);
      await group.tab.getByRole("button", { name: "Löschen" }).click();
      await group.tab.getByRole("alertdialog").getByRole("button", { name: "Abbrechen" }).click();
      expect(group.calls).toEqual(["PATCH /api/ipa-hosts/hostgroups/server"]);
      expect(group.bodies[0]).toEqual({ description: "Rechenraum, Keller" });
      await group.tab.getByRole("button", { name: "Löschen" }).click();
      await group.tab.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
      await group.tab.waitForURL((url) => !url.search.includes("group="));
      expect(group.calls.slice(1)).toEqual(["DELETE /api/ipa-hosts/hostgroups/server"]);
      expect([...errors, ...group.errors]).toEqual([]);
    } finally {
      await group.context.close();
    }
  }, 60_000);

  test("a sync asks twice, and the schedule can only be saved once it was read", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/admin/ipa-hosts");
    try {
      await tab.getByRole("button", { name: "Jetzt synchronisieren" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Synchronisierung starten" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Protokolle anzeigen" }).click();
      await tab.waitForURL(/observability\/logs\?source=ipa-hosts:sync/);
      expect(calls).toEqual(["POST /api/ipa-hosts/sync"]);
    } finally {
      await context.close();
    }
    const schedule = await open(desktop, "/admin/ipa-hosts");
    try {
      await schedule.tab.getByRole("button", { name: "Host-Synchronisierung" }).click();
      const dialog = schedule.tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Zeitplan (Cron)" }).fill("0 * * * *");
      await dialog.getByRole("button", { name: "Speichern" }).click();
      await closed(schedule.tab);
      expect(schedule.calls).toEqual(["PUT /api/ipa-hosts/settings/sync-cron"]);
      expect(schedule.bodies[0]).toEqual({ cron: "0 * * * *" });
    } finally {
      await schedule.context.close();
    }
    const unread = await open(desktop, "/admin/ipa-hosts", "normal", [{ request: "GET /api/ipa-hosts/settings/sync-cron", times: 1 }]);
    try {
      await unread.tab.getByRole("button", { name: "Host-Synchronisierung" }).click();
      expect(await unread.tab.getByRole("dialog").getByRole("button", { name: "Speichern" }).isDisabled()).toBe(true);
      expect([...errors, ...unread.errors]).toEqual([]);
    } finally {
      await unread.context.close();
    }
  }, 60_000);
});
