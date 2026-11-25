import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// An administrator opens, edits, creates and deletes FAQ entries; the address keeps what is open. The test answers the
// FAQ API itself and records what the screen sent; every entry is invented.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_FAQ_V2_SHOTS;
const SHARED = "0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e1002";
const CREATED = "0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e1004";

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "FaqScreens.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-faq-screens-test",
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
  if (!build.success) throw new AggregateError(build.logs, "FAQ screens harness build failed");
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

const page = (locale: string, state: string) =>
  `<!doctype html><html lang="${locale}" class="light" data-state="${state}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };
const tablet: View = { width: 1024, height: 800, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

type Call = { method: string; path: string; body: unknown };

const open = async (view: View, address: string, options: { locale?: string; state?: string; fail?: boolean } = {}) => {
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
  const calls: Call[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/faq" || url.pathname === "/admin/faq")
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: page(options.locale ?? "en", options.state ?? "normal") });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (url.pathname.startsWith("/api/faq")) {
      calls.push({ method: request.method(), path: url.pathname, body: request.postData() ? JSON.parse(request.postData()!) : null });
      if (options.fail) return route.fulfill({ status: 500, json: { message: "The FAQ store does not answer." } });
      if (request.method() === "POST") return route.fulfill({ status: 201, json: { id: CREATED } });
      return route.fulfill({ status: 200, json: { message: "ok" } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, calls };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("the FAQ administration on v2", () => {
  test("a row opens its form in the address; saving sends both languages and keeps the entry open", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/admin/faq");
    try {
      await tab.getByRole("link", { name: /Who can see a shared address book\?/ }).click();
      await tab.waitForURL(new RegExp(`entry=${SHARED}`));
      await tab.waitForSelector('body[data-ready="true"]');
      const answer = tab.getByLabel("Answer (English)");
      await answer.fill("Everyone you add as a member.");
      await tab.getByRole("checkbox", { name: "Guest profiles" }).check();
      await tab.getByRole("button", { name: "Save" }).click();
      await tab.waitForFunction(() => window.document.body.dataset.ready === "true" && location.search.includes("entry="));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "PATCH",
        path: `/api/faq/${SHARED}`,
        body: {
          audience: ["guest", "user"],
          translations: {
            en: { question: "Who can see a shared address book?", answer: "Everyone you add as a member." },
            de: { question: "Wer sieht ein geteiltes Adressbuch?" },
          },
        },
      });
      expect(new URL(tab.url()).searchParams.get("entry")).toBe(SHARED);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a new entry names missing fields at their place, then creates and opens the entry", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/admin/faq?entry=new");
    try {
      await tab.getByRole("button", { name: "Create entry" }).click();
      expect(await tab.getByText("Enter a question.").isVisible()).toBe(true);
      expect(await tab.getByText("Enter an answer.").isVisible()).toBe(true);
      expect(calls).toEqual([]);
      await tab.getByLabel("Question (English)").fill("Can I print a contact?");
      await tab.getByLabel("Answer (English)").fill("Yes, from its page.");
      // a German question without its answer is half a translation
      await tab.getByLabel("Question (German)").fill("Kann ich einen Kontakt drucken?");
      await tab.getByRole("button", { name: "Create entry" }).click();
      expect(await tab.getByText("Enter an answer.").isVisible()).toBe(true);
      await tab.getByLabel("Answer (German)").fill("Ja, von seiner Seite aus.");
      await tab.getByRole("button", { name: "Create entry" }).click();
      await tab.waitForURL(new RegExp(`entry=${CREATED}`));
      expect(calls.map((call) => call.method)).toEqual(["POST"]);
      expect(calls[0]!.body).toMatchObject({ audience: ["guest", "user"], translations: { de: { answer: "Ja, von seiner Seite aus." } } });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("deleting asks first and returns to the list; a failed save says so in the form and keeps the words", async () => {
    const { context, tab, errors, calls } = await open(desktop, `/admin/faq?entry=${SHARED}`);
    try {
      await tab.getByRole("button", { name: "More actions for this entry" }).click();
      await tab.getByRole("menuitem", { name: "Delete" }).click();
      await tab.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
      await tab.waitForURL((url) => url.pathname === "/admin/faq" && !url.search.includes("entry="));
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([`DELETE /api/faq/${SHARED}`]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
    const failing = await open(desktop, `/admin/faq?entry=${SHARED}`, { fail: true });
    try {
      await failing.tab.getByLabel("Question (English)").fill("Who sees a shared book?");
      await failing.tab.getByRole("button", { name: "Save" }).click();
      await failing.tab.getByText("The FAQ store does not answer.").waitFor();
      expect(await failing.tab.getByLabel("Question (English)").inputValue()).toBe("Who sees a shared book?");
      expect(failing.errors).toEqual([]);
    } finally {
      await failing.context.close();
    }
  }, 60_000);

  test("both screens keep the v2 rules at 1440, 1024 and 390 px, also in the worst case", async () => {
    const cases: [string, string, View, string][] = [
      ["01-faq-lesen-1440", "/faq", desktop, "normal"],
      ["02-faq-lesen-1024", "/faq", tablet, "normal"],
      ["03-faq-lesen-390", "/faq", phone, "normal"],
      ["04-faq-lesen-worst-1440", "/faq", desktop, "worst"],
      ["05-faq-lesen-worst-390", "/faq", phone, "worst"],
      ["06-faq-lesen-leer-1440", "/faq", desktop, "empty"],
      ["07-faq-admin-1440", "/admin/faq", desktop, "normal"],
      ["08-faq-admin-eintrag-1440", `/admin/faq?entry=${SHARED}`, desktop, "normal"],
      ["09-faq-admin-eintrag-1024", `/admin/faq?entry=${SHARED}`, tablet, "normal"],
      ["10-faq-admin-390", "/admin/faq", phone, "normal"],
      ["11-faq-admin-eintrag-390", `/admin/faq?entry=${SHARED}`, phone, "normal"],
      ["12-faq-admin-neu-1440", "/admin/faq?entry=new", desktop, "normal"],
      ["13-faq-admin-worst-1440", "/admin/faq?entry=0b6c3c1e-1f7a-4d55-9a1e-2f0a9d7e2001", desktop, "worst"],
      ["14-faq-admin-worst-390", "/admin/faq", phone, "worst"],
      ["15-faq-admin-leer-1440", "/admin/faq", desktop, "empty"],
    ];
    for (const [name, address, view, state] of cases) {
      const { context, tab, errors } = await open(view, address, { locale: "de", state });
      try {
        const outline = await describeV2Page(tab, "#root");
        expect({ name, outline: outline.includes("Problems (") ? outline : "" }).toEqual({ name, outline: "" });
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ name, problems: layout.problems }).toEqual({ name, problems: [] });
        await shoot(tab, name);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    // the question before deleting, and the errors at their fields
    const asking = await open(desktop, `/admin/faq?entry=${SHARED}`, { locale: "de" });
    try {
      await asking.tab.getByRole("button", { name: "Weitere Aktionen für diesen Eintrag" }).click();
      await asking.tab.getByRole("menuitem", { name: "Löschen" }).click();
      await asking.tab.getByRole("alertdialog").waitFor();
      await settled(asking.tab);
      await shoot(asking.tab, "16-faq-admin-loeschen-1440");
    } finally {
      await asking.context.close();
    }
    const invalid = await open(desktop, "/admin/faq?entry=new", { locale: "de" });
    try {
      await invalid.tab.getByRole("button", { name: "Eintrag erstellen" }).click();
      await settled(invalid.tab);
      await shoot(invalid.tab, "17-faq-admin-fehler-1440");
    } finally {
      await invalid.context.close();
    }
  }, 240_000);
});
