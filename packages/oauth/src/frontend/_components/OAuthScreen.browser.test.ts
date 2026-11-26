import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadShellAssets, type ShellAssets } from "@k2b/cloud/testing";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import { FAKE_SECRET, fixtureClient, NORMAL } from "./oauth-fixture-data";

// OAuth on v2, from invented clients: the screen keeps the v2 layout rules at desktop, tablet and phone width with
// normal, worst-case and no data; a client opens beside the list, and every deed sends the contract it sent before,
// asks first where it cannot be taken back, and shows a secret only once (a fake). `CLOUD_OAUTH_V2_SHOTS=<dir>` also
// saves a light screenshot per view, data set and width.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_OAUTH_V2_SHOTS;
const API = "/api/oauth/admin/clients";

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "OAuthScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-oauth-test",
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
  if (!build.success) throw new AggregateError(build.logs, "OAuth harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let harness: string;
let assets: ShellAssets;
beforeAll(async () => {
  harness = await buildHarness();
  // the shell's own stylesheets, Plex fonts and icons, as the page loads them
  assets = await loadShellAssets({ id: "oauth", css: resolve(import.meta.dir, "../../styles/app.css") });
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

/** How the API answers: requests ("METHOD path") that fail, each only `times` often; `hold` keeps a create waiting. */
type Answers = { failures?: { request: string; times: number }[]; hold?: Promise<void> };

const open = async (view: View, address: string, state = "normal", answers: Answers = {}) => {
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
  const left = (answers.failures ?? []).map((failure) => ({ ...failure }));
  // nothing leaves the test origin
  await context.route("**", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort("blockedbyclient");
    if (url.pathname === "/admin/oauth") return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(state) });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (await assets.serve(route, url)) return;
    const method = route.request().method();
    const request = `${method} ${url.pathname}`;
    if (url.pathname.startsWith(API)) {
      calls.push(request);
      bodies.push(method === "GET" || method === "DELETE" ? null : route.request().postDataJSON());
    }
    const failure = left.find((candidate) => candidate.request === request && candidate.times > 0);
    if (failure) {
      failure.times -= 1;
      return route.fulfill({ status: 503, json: { message: "Unavailable" } });
    }
    if (url.pathname === "/api/accounts/entities")
      return route.fulfill({
        json: {
          items: [
            { kind: "user", user: { id: "11111111-1111-4111-8111-000000000007", uid: "ada", displayName: "Ada Renz" } },
            { kind: "group", group: { id: "22222222-2222-4222-8222-000000000007", name: "betrieb" } },
          ],
        },
      });
    if (url.pathname.startsWith(API)) {
      // the list read again after a create: the clients and the new one, as the service returns them
      if (method === "GET" && url.pathname === API)
        return route.fulfill({
          json: {
            clients: [...NORMAL, fixtureClient(90, { name: "Wiki", clientId: "oc_wiki" })],
            pagination: { page: 1, per_page: 50, total: NORMAL.length + 1, total_pages: 1, has_next: false },
          },
        });
      if (method === "POST" && url.pathname === API) {
        await answers.hold;
        return route.fulfill({ json: { clientId: "oc_wiki", clientSecret: FAKE_SECRET } });
      }
      if (url.pathname.endsWith("/regenerate-secret")) return route.fulfill({ json: { clientSecret: FAKE_SECRET } });
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

/** The page after a deed sent it on: the harness renders again. */
const reloaded = (tab: Page) => tab.waitForEvent("load");

const GRAFANA = "00000000-0000-4000-8000-000000000002";
const PAPERLESS = "00000000-0000-4000-8000-000000000003";
const CLAUDE = "00000000-0000-4000-8000-000000000005";

describe("OAuth on v2", () => {
  test("the screen keeps the v2 rules at 1440, 1024 and 390 px, with normal, worst-case and no data", async () => {
    const cases: [name: string, state: string, search: string, view: View][] = [
      ["clients-normal-1440", "normal", "", desktop],
      ["clients-normal-1024", "normal", "", tablet],
      ["clients-normal-390", "normal", "", phone],
      ["clients-worst-1440", "worst", "", desktop],
      ["clients-worst-390", "worst", "", phone],
      ["clients-empty-1440", "empty", "", desktop],
      ["clients-empty-390", "empty", "", phone],
      ["clients-nomatch-1440", "empty", "?search=gibtsnicht", desktop],
      ["endpoints-1440", "normal", "?tab=endpoints", desktop],
      ["endpoints-390", "normal", "?tab=endpoints", phone],
      ["record-1440", "normal", `?client=${PAPERLESS}`, desktop],
      ["record-first-party-1440", "normal", "?client=00000000-0000-4000-8000-000000000001", desktop],
      ["record-dynamic-390", "normal", `?client=${CLAUDE}`, phone],
      ["record-worst-1440", "worst", "?client=00000000-0000-4000-8000-000000000100", desktop],
      ["record-worst-390", "worst", "?client=00000000-0000-4000-8000-000000000100", phone],
      ["record-gone-1440", "normal", "?client=00000000-0000-4000-8000-000000000999", desktop],
    ];
    for (const [name, state, search, view] of cases) {
      const { context, tab, errors } = await open(view, `/admin/oauth${search}`, state);
      try {
        const outline = await describeV2Page(tab, "#root");
        expect({ name, problems: outline.includes("Problems (") ? outline : "" }).toEqual({ name, problems: "" });
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ name, problems: layout.problems }).toEqual({ name, problems: [] });
        await shoot(tab, `oauth-${name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 300_000);

  test("a new client needs a name, sends the contract it sent before, then shows its secret once", async () => {
    const { context, tab, errors, calls, bodies } = await open(desktop, "/admin/oauth");
    try {
      await tab.getByRole("button", { name: "Neuer Client" }).first().click();
      const dialog = tab.getByRole("dialog");
      expect(await dialog.getByRole("button", { name: "Erstellen" }).isDisabled()).toBe(true);
      await dialog.getByRole("textbox", { name: "Name" }).fill("Wiki");
      await dialog
        .getByRole("textbox", { name: "Weiterleitungs-URIs" })
        .fill("https://wiki.example/callback\n'https://wiki.example/second'\n");
      // device sign-in is a choice only for a public client
      expect(await dialog.getByRole("group", { name: "Geräteanmeldung" }).count()).toBe(0);
      await shoot(tab, "oauth-dialog-new-1440");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      const secret = tab.getByRole("dialog", { name: "Client erstellt" });
      await secret.getByText(FAKE_SECRET).waitFor();
      expect(await secret.innerText()).toContain("oc_wiki");
      expect(await secret.innerText()).toContain("Speichere dieses Secret jetzt.");
      await shoot(tab, "oauth-dialog-secret-1440");
      // the create, then the list read again behind the secret
      expect(calls).toEqual([`POST ${API}`, `GET ${API}`]);
      expect(bodies[0]).toEqual({
        name: "Wiki",
        audiences: ["cloud"],
        isPublic: false,
        redirectUris: ["https://wiki.example/callback", "https://wiki.example/second"],
        scopes: ["openid", "profile", "email"],
        allowedProfiles: ["user"],
        accessMode: "profiles",
        allowedUserIds: [],
        allowedGroupIds: [],
        allowDeviceGrant: false,
      });
      // the secret is not shown again: closing shows the list as it is now
      await Promise.all([reloaded(tab), secret.getByRole("button", { name: "Schließen" }).first().click()]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a public client may take device sign-in, and access for chosen users and groups needs a choice", async () => {
    const { context, tab, errors, bodies } = await open(desktop, "/admin/oauth");
    try {
      await tab.getByRole("button", { name: "Neuer Client" }).first().click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name" }).fill("Terminal");
      await dialog.getByRole("checkbox", { name: "Öffentlicher Client" }).check();
      await dialog.getByRole("group", { name: "Geräteanmeldung" }).getByRole("checkbox").check();
      await dialog.getByRole("checkbox", { name: "Nur bestimmte Benutzer und Gruppen" }).check();
      expect(await dialog.innerText()).toContain("Wähle mindestens einen Benutzer oder eine Gruppe aus.");
      expect(await dialog.getByRole("button", { name: "Erstellen" }).isDisabled()).toBe(true);
      await dialog.getByRole("searchbox").fill("a");
      await dialog.getByRole("option", { name: /Ada Renz/ }).click();
      await dialog.getByRole("option", { name: /betrieb/i }).click();
      await shoot(tab, "oauth-dialog-access-1440");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await tab.getByRole("dialog", { name: "Client erstellt" }).waitFor();
      expect(bodies[0]).toMatchObject({
        isPublic: true,
        allowDeviceGrant: true,
        accessMode: "specific",
        allowedUserIds: ["11111111-1111-4111-8111-000000000007"],
        allowedGroupIds: ["22222222-2222-4222-8222-000000000007"],
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("editing keeps every callback and the chosen users and groups, in one PUT", async () => {
    const { context, tab, errors, calls, bodies } = await open(desktop, `/admin/oauth?client=${PAPERLESS}`);
    try {
      await tab.getByRole("button", { name: "Bearbeiten" }).click();
      const dialog = tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Beschreibung" }).fill("Belege und Rechnungen");
      await Promise.all([reloaded(tab), dialog.getByRole("button", { name: "Speichern" }).click()]);
      expect(calls).toEqual([`PUT ${API}/${PAPERLESS}`]);
      expect(bodies[0]).toEqual({
        description: "Belege und Rechnungen",
        redirectUris: ["https://belege.werkstatt.example/accounts/oidc/cloud/login/callback/"],
        logoutUri: null,
        scopes: ["openid", "profile", "email"],
        allowedProfiles: ["user"],
        accessMode: "specific",
        allowedUserIds: ["11111111-1111-4111-8111-000000000001"],
        allowedGroupIds: ["22222222-2222-4222-8222-000000000001"],
        allowDeviceGrant: false,
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a create that waits keeps its dialog on Escape; a failed one says so and keeps the input", async () => {
    let release = () => {};
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const waiting = await open(desktop, "/admin/oauth", "normal", { hold });
    try {
      await waiting.tab.getByRole("button", { name: "Neuer Client" }).first().click();
      const dialog = waiting.tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name" }).fill("Wiki");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await waiting.tab.keyboard.press("Escape");
      await settled(waiting.tab);
      expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Wiki");
      release();
      await waiting.tab.getByRole("dialog", { name: "Client erstellt" }).waitFor();
      expect(waiting.errors).toEqual([]);
    } finally {
      await waiting.context.close();
    }

    const failing = await open(desktop, "/admin/oauth", "normal", { failures: [{ request: `POST ${API}`, times: 1 }] });
    try {
      await failing.tab.getByRole("button", { name: "Neuer Client" }).first().click();
      const dialog = failing.tab.getByRole("dialog");
      await dialog.getByRole("textbox", { name: "Name" }).fill("Wiki");
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await dialog.getByText("Client konnte nicht erstellt werden.").waitFor();
      expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Wiki");
      expect(failing.errors).toEqual([]);
    } finally {
      await failing.context.close();
    }
  }, 60_000);

  test("deleting and revoking ask first and send only when agreed; a failed delete offers a retry", async () => {
    const managed = await open(desktop, `/admin/oauth?client=${GRAFANA}`, "normal", {
      failures: [{ request: `DELETE ${API}/${GRAFANA}`, times: 1 }],
    });
    try {
      await managed.tab.getByRole("button", { name: "Weitere Aktionen" }).click();
      await managed.tab.getByRole("menuitem", { name: "Löschen" }).click();
      await managed.tab.getByRole("alertdialog").getByRole("button", { name: "Abbrechen" }).click();
      expect(managed.calls).toEqual([]);
      await managed.tab.getByRole("button", { name: "Weitere Aktionen" }).click();
      await managed.tab.getByRole("menuitem", { name: "Löschen" }).click();
      await managed.tab.getByRole("alertdialog").getByRole("button", { name: "Löschen" }).click();
      await managed.tab.getByRole("button", { name: "Erneut versuchen" }).click();
      await managed.tab.waitForURL((url) => url.pathname === "/admin/oauth" && !url.searchParams.has("client"));
      expect(managed.calls).toEqual([`DELETE ${API}/${GRAFANA}`, `DELETE ${API}/${GRAFANA}`]);
      expect(managed.errors).toEqual([]);
    } finally {
      await managed.context.close();
    }

    const dynamic = await open(phone, `/admin/oauth?client=${CLAUDE}`);
    try {
      // a client that registered itself is revoked, never edited, and keeps no secret to renew
      expect(await dynamic.tab.getByRole("button", { name: "Bearbeiten" }).count()).toBe(0);
      expect(await dynamic.tab.getByRole("button", { name: "Neu erzeugen" }).count()).toBe(0);
      await dynamic.tab.getByRole("button", { name: "Widerrufen" }).click();
      const question = dynamic.tab.getByRole("alertdialog");
      expect(await question.innerText()).toContain("Client widerrufen?");
      await question.getByRole("button", { name: "Widerrufen" }).click();
      await dynamic.tab.waitForURL((url) => !url.searchParams.has("client"));
      expect(dynamic.calls).toEqual([`DELETE ${API}/${CLAUDE}`]);
      expect(dynamic.errors).toEqual([]);
    } finally {
      await dynamic.context.close();
    }
  }, 60_000);

  test("on the phone the head keeps Edit and the menu with Delete and Renew within reach", async () => {
    const { context, tab, errors } = await open(phone, `/admin/oauth?client=${GRAFANA}`);
    try {
      expect(await tab.getByRole("button", { name: "Bearbeiten" }).isVisible()).toBe(true);
      await tab.getByRole("button", { name: "Weitere Aktionen" }).click();
      for (const deed of ["Neu erzeugen", "Löschen"]) expect(await tab.getByRole("menuitem", { name: deed }).isVisible(), deed).toBe(true);
      await shoot(tab, "oauth-record-menu-390");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("renewing a secret asks first and shows the new one once; Cloud's own client has no deeds", async () => {
    const { context, tab, errors, calls } = await open(desktop, `/admin/oauth?client=${GRAFANA}`);
    try {
      await tab.getByRole("button", { name: "Weitere Aktionen" }).click();
      await tab.getByRole("menuitem", { name: "Neu erzeugen" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Abbrechen" }).click();
      expect(calls).toEqual([]);
      await tab.getByRole("button", { name: "Weitere Aktionen" }).click();
      await tab.getByRole("menuitem", { name: "Neu erzeugen" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Neu erzeugen" }).click();
      const secret = tab.getByRole("dialog", { name: "Secret neu erzeugt" });
      await secret.getByText(FAKE_SECRET).waitFor();
      expect(calls).toEqual([`POST ${API}/${GRAFANA}/regenerate-secret`]);
      await secret.getByRole("button", { name: "Schließen" }).first().click();
      await secret.waitFor({ state: "hidden" });
      expect(await tab.getByText(FAKE_SECRET).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }

    const own = await open(desktop, "/admin/oauth?client=00000000-0000-4000-8000-000000000001");
    try {
      for (const deed of ["Bearbeiten", "Weitere Aktionen", "Widerrufen"])
        expect(await own.tab.getByRole("button", { name: deed }).count(), deed).toBe(0);
    } finally {
      await own.context.close();
    }
  }, 60_000);
});
