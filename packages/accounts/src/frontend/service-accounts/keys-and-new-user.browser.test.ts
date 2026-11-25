import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";
import "../../../../ui/test/solid-ssr-preload";
import { AGENT_ID, accountRequest, HUGE_TOTAL, hugeSources, KEY_IDS, OTHER_AGENT_ID, PERSON_ID, TOKEN } from "./keys-and-new-user.fixture";

// An administrator works with an account's API keys and directory access as sections of its record, with the list of
// all keys while it still has its route, and creates a person's account (also from a request). The screens render from
// invented fixtures; the test answers every API itself.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_ACCOUNTS_V2_SHOTS;

type State =
  | { screen: "record"; keys?: "sample" | "worst" | "huge" | "empty" | "failed"; active?: boolean }
  | { screen: "list"; rows?: "sample" | "worst" | "empty" }
  | { screen: "new-user"; request?: boolean; emailOptional?: boolean };

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "KeysAndNewUser.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-keys-and-new-user-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Keys and new-user harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const wide: View = { width: 1440, height: 900, touch: false, name: "1440" };
const narrow: View = { width: 1024, height: 768, touch: false, name: "1024" };
const phone: View = { width: 390, height: 844, touch: true, name: "390" };

const html = (state: State) =>
  `<!doctype html><html lang="de" class="light" data-state='${JSON.stringify(state)}'><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** What the test's API answers, in order, and what it received. */
type Api = {
  /** Answers to creating a key: a token, a refusal, or a lost answer. */
  create: ("token" | 400 | "lost")[];
  /** Answers to a new directory share. */
  share: number[];
  /** Answers to creating a user. */
  user: number[];
  posts: { path: string; body: unknown }[];
  deletes: string[];
  pages: string[];
  shares: { id: string; label: string; principal: unknown; serviceAccountKind: null }[];
  /** Pages of an agent's keys the section asked the API for. */
  keyPages: number[];
};
const api = (patch: Partial<Api> = {}): Api => ({
  create: [],
  share: [],
  user: [],
  posts: [],
  deletes: [],
  pages: [],
  shares: [],
  ...patch,
});

const routes: Record<string, (url: URL) => State> = {
  [`/app/accounts/users/${AGENT_ID}`]: () => ({ screen: "record" }),
  "/app/accounts/api-keys": () => ({ screen: "list" }),
  "/app/accounts/users/new": (url) => ({ screen: "new-user", request: url.searchParams.has("request") }),
};

const open = async (view: View, address: string, answers: Api, state?: State) => {
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
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const screen = routes[url.pathname];
    if (screen) {
      answers.pages.push(`${url.pathname}${url.search}`);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: html(state ?? screen(url)) });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (url.pathname === "/api/admin/identity/service-accounts")
      return route.fulfill({
        json: {
          items: [
            { id: AGENT_ID, name: "Wochenbericht", kind: "agent" },
            { id: OTHER_AGENT_ID, name: "Rechnungseingang", kind: "standalone" },
          ].filter((item) => item.name.toLowerCase().includes((url.searchParams.get("search") ?? "").toLowerCase())),
        },
      });
    if (url.pathname === `/api/admin/identity/service-accounts/${AGENT_ID}/api-keys` && method === "GET") {
      const pageNumber = Number(url.searchParams.get("page") ?? 1);
      const perPage = Number(url.searchParams.get("perPage") ?? 100);
      answers.keyPages.push(pageNumber);
      return route.fulfill({
        json: {
          items: hugeSources(pageNumber, perPage),
          page: pageNumber,
          perPage,
          total: HUGE_TOTAL,
          hasNext: pageNumber * perPage < HUGE_TOTAL,
        },
      });
    }
    if (url.pathname.endsWith("/api-keys") && method === "POST") {
      answers.posts.push({ path: url.pathname, body: request.postDataJSON() });
      const answer = answers.create.shift() ?? "token";
      if (answer === "lost") return route.abort("connectionreset");
      if (answer === 400) return route.fulfill({ status: 400, json: { message: "Das Konto ist deaktiviert." } });
      return route.fulfill({ status: 201, json: { credential: { id: "new" }, token: TOKEN } });
    }
    if (url.pathname.startsWith("/api/accounts/service-accounts/credentials/") && method === "DELETE") {
      answers.deletes.push(url.pathname);
      return route.fulfill({ json: { revoked: true } });
    }
    if (url.pathname === "/api/accounts/entities")
      return route.fulfill({
        json: { items: [{ id: PERSON_ID, kind: "user", user: { id: PERSON_ID, uid: "ada", displayName: "Ada Renz", avatarHash: null } }] },
      });
    if (url.pathname.startsWith("/api/admin/identity/directory-shares/")) {
      if (method === "POST") {
        answers.posts.push({ path: url.pathname, body: request.postDataJSON() });
        const status = answers.share.shift() ?? 201;
        if (status !== 201) return route.fulfill({ status, json: { message: "Nicht verfügbar" } });
        answers.shares.push({
          id: "6d000000-0000-4000-8000-000000000099",
          label: "Ada Renz",
          principal: { type: "user", userId: PERSON_ID },
          serviceAccountKind: null,
        });
        return route.fulfill({ status: 201, json: { id: "6d000000-0000-4000-8000-000000000099" } });
      }
      if (method === "DELETE") {
        answers.deletes.push(url.pathname);
        const id = url.pathname.split("/").at(-1);
        answers.shares = answers.shares.filter((share) => share.id !== id);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { items: answers.shares, total: answers.shares.length, page: 1, perPage: 20 } });
    }
    if (url.pathname === "/api/accounts/users" && method === "POST") {
      answers.posts.push({ path: url.pathname, body: request.postDataJSON() });
      const status = answers.user.shift() ?? 201;
      if (status !== 201) return route.fulfill({ status, json: { message: "Diese Adresse gibt es schon." } });
      return route.fulfill({
        status: 201,
        json: {
          id: PERSON_ID,
          uid: "ada.renz",
          accountExpires: null,
          notificationSent: true,
          creationNotice: { markdown: "Bitte **Arbeitsplatz** einrichten.", failed: false },
        },
      });
    }
    if (url.pathname === `/api/accounts/account-requests/${accountRequest.id}/deny` && method === "POST") {
      answers.posts.push({ path: url.pathname, body: request.postDataJSON() });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `c-${name}.png`) });
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
};

const dialog = (tab: Page) => tab.locator("[data-k2-part=Dialog]").last();
const record = `/app/accounts/users/${AGENT_ID}`;

describe("an account's API keys and directory access as record sections", () => {
  test("keep the v2 rules at 1440, 1024 and 390 px with sample, worst-case, empty and failed keys", async () => {
    for (const view of [wide, narrow, phone])
      for (const keys of ["sample", "worst", "empty", "failed"] as const) {
        const { context, tab, errors } = await open(view, record, api(), { screen: "record", keys });
        try {
          await expectClean(tab);
          if (keys !== "failed") await shoot(tab, `record-${keys}-light-${view.name}`);
          if (keys === "failed") expect(await tab.getByRole("button", { name: "Erneut versuchen" }).count()).toBe(1);
          // the first picture comes with its data: nothing loads
          expect(await tab.locator("[data-k2-part=Loading]").count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
  }, 120_000);

  test("1,284 keys: the true count, one API page of 50 rows, ready in under 1.5 s, the next page from the API", async () => {
    const answers = api();
    const { context, tab, errors } = await open(wide, record, answers, { screen: "record", keys: "huge" });
    try {
      await tab.getByRole("button", { name: "Gerät 2", exact: true }).waitFor();
      // milliseconds since the page's navigation began, measured in the page
      const ready = await tab.evaluate(() => performance.now());
      expect(ready).toBeLessThan(1500);
      const keys = tab.locator("[data-k2-part=Section]").first();
      expect(await keys.locator("[data-k2-part=Row]").count()).toBe(50);
      expect(await tab.locator("#root *").count()).toBeLessThan(2500);
      expect(await keys.textContent()).toContain("1.284");
      expect(await tab.textContent("body")).toContain("Seite 1 von 26");
      // the long first name is shortened in the middle; the open key shows it whole
      const first = keys.locator("[data-k2-part=Row]").first();
      expect(await first.textContent()).toContain("…");
      expect(answers.keyPages).toEqual([]);
      await expectClean(tab);
      await shoot(tab, "record-huge-light-1440");
      await tab.getByRole("button", { name: "Weiter" }).first().click();
      await tab.getByRole("button", { name: "Gerät 51", exact: true }).waitFor();
      expect(answers.keyPages).toEqual([2]);
      expect(await tab.textContent("body")).toContain("Seite 2 von 26");
      expect(await keys.locator("[data-k2-part=Row]").count()).toBe(50);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a new key: models only by default, a refusal keeps the form, the token shows once, closing reads the record", async () => {
    const answers = api({ create: [400, "token"] });
    const { context, tab, errors } = await open(wide, record, answers);
    try {
      await tab.getByRole("button", { name: "API Key erstellen" }).first().click();
      await dialog(tab).waitFor();
      expect(await dialog(tab).getByRole("radio", { name: "Nur KI-Modelle" }).isChecked()).toBe(true);
      await dialog(tab).getByRole("textbox", { name: /Name/ }).fill("Nachtlauf");
      await shoot(tab, "record-new-key-light-1440");
      await dialog(tab).getByRole("button", { name: "API Key erstellen" }).click();
      await dialog(tab).getByText("Das Konto ist deaktiviert.").waitFor();
      expect(await dialog(tab).getByRole("textbox", { name: /Name/ }).inputValue()).toBe("Nachtlauf");
      await dialog(tab).getByRole("button", { name: "API Key erstellen" }).click();
      await dialog(tab).getByText(TOKEN).waitFor();
      expect(answers.posts.map((post) => post.body)).toEqual([
        { name: "Nachtlauf", access: "models", expiresAt: null },
        { name: "Nachtlauf", access: "models", expiresAt: null },
      ]);
      expect(answers.posts[0]!.path).toBe(`/api/admin/identity/service-accounts/${AGENT_ID}/api-keys`);
      await shoot(tab, "record-token-light-1440");
      // closing reads the record again, which shows the new key
      const reread = tab.waitForRequest((request) => new URL(request.url()).pathname === record);
      await dialog(tab).getByRole("button", { name: "Fertig" }).click();
      await reread;
      await tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a lost answer offers no second key; a last day must be a future day", async () => {
    const answers = api({ create: ["lost"] });
    const { context, tab, errors } = await open(wide, record, answers);
    try {
      await tab.getByRole("button", { name: "API Key erstellen" }).first().click();
      await dialog(tab).getByRole("textbox", { name: /Name/ }).fill("Nachtlauf");
      await dialog(tab)
        .getByRole("textbox", { name: /Läuft ab/ })
        .fill("01.01.2020");
      await dialog(tab).getByRole("button", { name: "API Key erstellen" }).click();
      await dialog(tab)
        .getByText(/künftigen Tag/)
        .waitFor();
      expect(answers.posts).toHaveLength(0);
      await dialog(tab)
        .getByRole("textbox", { name: /Läuft ab/ })
        .fill("31.12.2099");
      await dialog(tab).getByRole("button", { name: "API Key erstellen" }).click();
      await tab.waitForFunction(() => document.querySelector("[data-k2-part=Dialog] [role=alert]") !== null);
      expect(await dialog(tab).getByRole("button", { name: "API Key erstellen" }).isDisabled()).toBe(true);
      expect(answers.posts).toHaveLength(1);
      expect((answers.posts[0]!.body as { expiresAt: string }).expiresAt).toBe("2099-12-31T23:00:00.000Z");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("revoke asks once; a legacy key is replaced by a new one and revoked only on request", async () => {
    const answers = api();
    const { context, tab, errors } = await open(wide, record, answers);
    try {
      await tab.getByRole("button", { name: "Aktionen für Laptop Jana" }).click();
      await tab.getByRole("menuitem", { name: "Widerrufen", exact: true }).click();
      const reread = tab.waitForRequest((request) => new URL(request.url()).pathname === record);
      await tab.getByRole("alertdialog").getByRole("button", { name: "Widerrufen" }).click();
      await reread;
      expect(answers.deletes).toEqual([`/api/accounts/service-accounts/credentials/${KEY_IDS[0]}`]);

      // the legacy key opens with its facts and its two deeds; "Ersetzen" creates the new key first
      await tab.getByRole("button", { name: "Alter Export-Job", exact: true }).click();
      await dialog(tab).getByRole("button", { name: "Ersetzen" }).click();
      await dialog(tab).getByRole("button", { name: "Neuen API Key erstellen" }).click();
      await dialog(tab).getByText(TOKEN).waitFor();
      expect(answers.posts.at(-1)?.body).toEqual({ name: "Alter Export-Job", access: "full", expiresAt: null });
      expect(answers.deletes).toHaveLength(1);
      await dialog(tab).getByRole("button", { name: "Alten widerrufen" }).click();
      await tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(answers.deletes.at(-1)).toBe(`/api/accounts/service-accounts/credentials/${KEY_IDS[1]}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("directory access: a failed share keeps the entries and repeats, a removal leaves the list", async () => {
    const answers = api({ share: [503] });
    const { context, tab, errors } = await open(wide, record, answers);
    try {
      expect(await tab.getByRole("button", { name: /Verzeichniszugriff widerrufen: Jana Berger/ }).count()).toBe(1);
      await tab.getByRole("combobox").last().fill("Ada");
      await tab.getByRole("option", { name: /Ada Renz/ }).click();
      await tab.getByText(/Verzeichniszugriff konnte nicht geändert werden/).waitFor();
      await tab.getByRole("button", { name: "Änderung wiederholen" }).click();
      await tab.getByRole("button", { name: "Verzeichniszugriff widerrufen: Ada Renz" }).waitFor();
      expect(answers.posts.map((post) => post.body)).toEqual([
        { principal: { type: "user", userId: PERSON_ID } },
        { principal: { type: "user", userId: PERSON_ID } },
      ]);
      await tab.getByRole("button", { name: "Verzeichniszugriff widerrufen: Ada Renz" }).click();
      await tab.getByText(/Keine Einträge freigegeben/).waitFor();
      expect(answers.deletes).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("the list of all API keys while it has its route", () => {
  test("keeps the v2 rules at 1440, 1024 and 390 px, with sample and worst-case rows", async () => {
    for (const view of [wide, narrow, phone])
      for (const rows of ["sample", "worst", "empty"] as const) {
        const { context, tab, errors } = await open(view, "/app/accounts/api-keys", api(), { screen: "list", rows });
        try {
          await expectClean(tab);
          await shoot(tab, `list-${rows}-light-${view.name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
  }, 120_000);

  test("“Show” names the automatic app keys in the address, and directory access opens for a chosen agent", async () => {
    const answers = api();
    const { context, tab, errors } = await open(wide, "/app/accounts/api-keys?kind=agent", answers);
    try {
      await tab.getByRole("link", { name: "Anzeigen", exact: true }).click();
      await tab.waitForFunction(() => new URL(location.href).search === "?kind=agent&automatic=1");
      await tab.getByRole("button", { name: "Mehr", exact: true }).click();
      await tab.getByRole("menuitem", { name: "Verzeichniszugriff" }).click();
      await dialog(tab).getByRole("searchbox").fill("Woche");
      await dialog(tab)
        .getByRole("option", { name: /Wochenbericht/ })
        .click();
      await dialog(tab)
        .getByText(/Keine Einträge freigegeben/)
        .waitFor();
      await shoot(tab, "list-directory-light-1440");
      await dialog(tab).getByRole("button", { name: "Schließen" }).last().click();
      await tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a new key from the list asks for its agent first", async () => {
    const answers = api();
    const { context, tab, errors } = await open(wide, "/app/accounts/api-keys", answers);
    try {
      await tab.getByRole("button", { name: "API Key erstellen" }).first().click();
      await dialog(tab).getByRole("textbox", { name: /Name/ }).fill("Abgleich");
      await dialog(tab).getByRole("button", { name: "API Key erstellen" }).click();
      await dialog(tab).getByText("Wähle einen Agenten.").waitFor();
      expect(answers.posts).toHaveLength(0);
      await dialog(tab).getByRole("searchbox").fill("Rech");
      await dialog(tab)
        .getByRole("option", { name: /Rechnungseingang/ })
        .click();
      await dialog(tab).getByRole("button", { name: "API Key erstellen" }).click();
      await dialog(tab).getByText(TOKEN).waitFor();
      expect(answers.posts[0]!.path).toBe(`/api/admin/identity/service-accounts/${OTHER_AGENT_ID}/api-keys`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});

describe("a new account on v2", () => {
  test("keeps the v2 rules at 1440, 1024 and 390 px, plain and from a request", async () => {
    for (const view of [wide, narrow, phone])
      for (const [name, address] of [
        ["new-user", "/app/accounts/users/new"],
        ["new-user-request", `/app/accounts/users/new?request=${accountRequest.id}`],
      ] as const) {
        const { context, tab, errors } = await open(view, address, api());
        try {
          await expectClean(tab);
          await shoot(tab, `${name}-light-${view.name}`);
          expect(await tab.locator("[data-k2-part=Loading]").count()).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
  }, 120_000);

  test("required fields say so, a refusal keeps the form, and the result leads to the account", async () => {
    const answers = api({ user: [409] });
    const { context, tab, errors } = await open(wide, "/app/accounts/users/new", answers);
    try {
      await tab.getByRole("button", { name: "Konto erstellen" }).click();
      await tab.getByText("Kontotyp auswählen").first().waitFor();
      expect(answers.posts).toHaveLength(0);
      await tab.getByRole("radio", { name: "Login" }).check();
      await tab.getByRole("textbox", { name: /Vorname/ }).fill("Ada");
      await tab.getByRole("textbox", { name: /Nachname/ }).fill("Renz");
      expect(await tab.getByRole("textbox", { name: /Anzeigename/ }).inputValue()).toBe("Ada Renz");
      await tab.getByRole("textbox", { name: /E-Mail/ }).fill("ada@kramer-lager.example");
      await tab.getByRole("checkbox", { name: /Administrationszugriff/ }).check();
      // a guest never keeps administration
      await tab.getByRole("radio", { name: "Gast" }).check();
      await tab.getByRole("radio", { name: "Login" }).check();
      expect(await tab.getByRole("checkbox", { name: /Administrationszugriff/ }).isChecked()).toBe(false);
      await tab.getByRole("button", { name: "Konto erstellen" }).click();
      await tab.getByText("Diese Adresse gibt es schon.").waitFor();
      expect(await tab.getByRole("textbox", { name: /E-Mail/ }).inputValue()).toBe("ada@kramer-lager.example");
      await tab.getByRole("button", { name: "Konto erstellen" }).click();
      await tab.getByRole("link", { name: "Konto anzeigen" }).waitFor();
      expect(await tab.getByRole("link", { name: "Konto anzeigen" }).getAttribute("href")).toBe(`/app/accounts/users/${PERSON_ID}`);
      expect(await tab.textContent("body")).toContain("Arbeitsplatz");
      expect(answers.posts.map((post) => post.body)).toEqual([
        expect.objectContaining({ provider: "local", profile: "user", admin: false, email: "ada@kramer-lager.example", givenname: "Ada" }),
        expect.objectContaining({ provider: "local", profile: "user" }),
      ]);
      await expectClean(tab);
      await shoot(tab, "new-user-created-light-1440");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("from a request the form is filled for FreeIPA, and the request can be denied with a reason", async () => {
    const answers = api();
    const { context, tab, errors } = await open(wide, `/app/accounts/users/new?request=${accountRequest.id}`, answers);
    try {
      expect(await tab.getByRole("radio", { name: "FreeIPA" }).isChecked()).toBe(true);
      expect(await tab.getByRole("textbox", { name: /Vorname/ }).inputValue()).toBe("Ida");
      await tab.getByRole("button", { name: "Anfrage ablehnen" }).first().click();
      await dialog(tab).getByRole("textbox").fill("Bitte über die Personalabteilung.");
      await shoot(tab, "new-user-deny-light-1440");
      await dialog(tab).getByRole("button", { name: "Anfrage ablehnen" }).click();
      await tab.waitForFunction(() => !document.querySelector("[data-k2-part=Dialog]"));
      expect(answers.posts).toEqual([
        { path: `/api/accounts/account-requests/${accountRequest.id}/deny`, body: { reason: "Bitte über die Personalabteilung." } },
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
