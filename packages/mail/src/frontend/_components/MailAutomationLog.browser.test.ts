import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { appColorStyle } from "@k2b/cloud/ssr/app-color";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import type { LogHarnessOptions } from "./MailAutomationLog.browser-harness";

// Row heights, the inline notes and the detail panel are layout, which only a real engine answers.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailAutomationLog.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-automation-log-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Automation log harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
const uiDist = new URL("../../../../ui/dist/", import.meta.url).pathname;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname === "/tabler.css" || url.pathname.endsWith(".woff2")) return new Response(Bun.file(uiDist + url.pathname.slice(1)));
    return new Response(
      `<!doctype html><html class="light" style="--app-accent:#0f766e;${appColorStyle("#0f766e")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        '<link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head>' +
        '<body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** `MAIL_LOG_SCREENSHOTS=<dir>` keeps light screenshots of each state for review. */
const screenshotDir = process.env.MAIL_LOG_SCREENSHOTS?.trim();
const keep = async (page: Page, name: string) => {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
};

const open = async (context: BrowserContextOptions, options: LogHarnessOptions, hold = false) => {
  const page = await (await browser.newContext(context)).newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url.href);
  await page.evaluate(
    ({ harnessOptions, hold }) => {
      window.mountAutomationLog(harnessOptions);
      if (hold) window.holdLoads();
    },
    { harnessOptions: options, hold },
  );
  await page.locator("[data-mail-automation-log]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return Object.assign(page, { errors });
};
const row = (page: Page, outcome: string) => page.locator(`[role="row"][data-log-outcome="${outcome}"]`).first();

describe("Mail automation Protokoll", () => {
  for (const [device, context] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`today's effects with reasons, Undo with Redo and the audit on ${device}`, async () => {
      const page = await open(context, { locale: "de", scenario: "normal" });
      try {
        await page.getByText("Zugewiesen an Nora Albrecht").first().waitFor();
        expect(await page.locator('[role="row"][data-log-outcome]').count()).toBe(8);
        await page.getByText("„Mails nach Art verteilen“ steht in der Reihenfolge davor und hat schon zugewiesen.").waitFor();
        await page.getByText("Für „Sonstiges“ steht kein Ziel in der Regel.").waitFor();
        await page.getByText("2 ältere anzeigen").waitFor();
        await keep(page, `protokoll-heute-light-${device}`);

        await page.getByRole("button", { name: /Fehldruck Tüten/ }).click();
        const detail = page.locator("[data-mail-automation-log-detail]");
        await detail.getByText("Feste Zeile: Reklamation und Betrag über 500 € → Nora Albrecht").waitFor();
        await detail.getByText("Aus dem Satz „Rechnung über 860 €“.").waitFor();
        await detail.getByText("2 KI-Aufrufe · heute 46 von 300 für diese Regel").waitFor();
        await keep(page, `protokoll-detail-light-${device}`);
        await detail.getByRole("button", { name: "Schließen" }).click();
        // Closing returns focus to the row, which may scroll it into view; measure after that.
        await page.waitForFunction(() => document.activeElement?.hasAttribute("data-log-open") === true);
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

        const before = await row(page, "assigned").boundingBox();
        await row(page, "assigned").getByRole("button", { name: "Rückgängig" }).click();
        await page.getByText("Rückgängig gemacht · 09:15").waitFor();
        // The toast rail also mirrors its text into a status region for screen readers; check the visible toast.
        await page
          .getByRole("region", { name: "Benachrichtigungen" })
          .getByText(/Zuweisung rückgängig gemacht\. „Reklamation Lieferung vom 14\.10\.“ ist wieder ohne Zuständige/)
          .waitFor();
        expect((await row(page, "assigned").boundingBox())?.y).toBe(before?.y);
        await keep(page, `protokoll-rueckgaengig-light-${device}`);
        await page.getByRole("button", { name: "Wiederholen" }).click();
        // Redo shows its result: the row is current again and offers Undo.
        await row(page, "assigned").getByRole("button", { name: "Rückgängig" }).waitFor();
        expect(await page.getByText("Rückgängig gemacht · 09:15").count()).toBe(0);
        expect(page.errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }, 40_000);
  }

  test("Undo after a person's change says what stays and changes nothing", async () => {
    const page = await open(desktop, { locale: "de", scenario: "notPossible" });
    try {
      await row(page, "assigned").getByRole("button", { name: "Rückgängig" }).click();
      await page.getByText("Nicht rückgängig gemacht.").waitFor();
      await page
        .getByText("Ida Lorenz hat die Unterhaltung um 09:10 selbst zugewiesen. Diese Zuweisung bleibt. Nichts wurde geändert.")
        .waitFor();
      await page.getByText("bleibt bei Ida Lorenz").waitFor();
      await page.getByRole("link", { name: "Unterhaltung öffnen" }).waitFor();
      await keep(page, "protokoll-nicht-moeglich-light-desktop");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the Uncertain filter, the empty day, loading rows and a failed load with recovery", async () => {
    const page = await open(desktop, { locale: "de", scenario: "normal" });
    try {
      await page.getByRole("radio", { name: /Unsicher/ }).click();
      await page.getByText("Unsicher: an „Eingang prüfen“").waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[role="row"][data-log-outcome]').length === 1);
      await keep(page, "protokoll-unsicher-light-desktop");
    } finally {
      await page.context().close();
    }
    const empty = await open(desktop, { locale: "de", scenario: "empty" });
    try {
      await empty.getByText("Heute hat noch keine Regel etwas getan.").waitFor();
      await keep(empty, "protokoll-leer-light-desktop");
    } finally {
      await empty.context().close();
    }
    const loading = await open(desktop, { locale: "de", scenario: "failing" }, true);
    try {
      await loading.getByRole("radio", { name: /Zuweisungen/ }).click();
      await loading.locator('[role="table"][aria-busy="true"]').waitFor();
      await keep(loading, "protokoll-laedt-light-desktop");
      await loading.evaluate(() => window.releaseLoads());
      await loading.getByText("Das Protokoll konnte nicht geladen werden.").waitFor();
      await loading.getByText("Die Filter bleiben, wie sie sind.").waitFor();
      expect(await loading.getByRole("radio", { name: /Zuweisungen/ }).getAttribute("aria-checked")).toBe("true");
      await keep(loading, "protokoll-fehler-light-desktop");
      await loading.getByRole("button", { name: "Erneut versuchen" }).click();
      await loading.getByText("Zugewiesen an Team Angebote").waitFor();
    } finally {
      await loading.context().close();
    }
  }, 40_000);

  test("Undo from the detail meets a person's change: the detail says so and offers no Undo", async () => {
    const page = await open(desktop, { locale: "de", scenario: "notPossible" });
    try {
      await page.getByRole("button", { name: /Fehldruck Tüten/ }).click();
      const detail = page.locator("[data-mail-automation-log-detail]");
      await detail.getByRole("button", { name: "Rückgängig" }).click();
      await detail
        .getByText("Ida Lorenz hat die Unterhaltung um 09:10 selbst zugewiesen. Diese Zuweisung bleibt. Nichts wurde geändert.")
        .waitFor();
      expect(await detail.getByRole("button", { name: "Rückgängig" }).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("an older page that arrives after a filter change stays out of the new view", async () => {
    const page = await open(desktop, { locale: "de", scenario: "normal" });
    try {
      await page.evaluate(() => window.holdLoads());
      await page.getByText("2 ältere anzeigen").click();
      await page.getByRole("radio", { name: /Unsicher/ }).click();
      await page.evaluate(() => window.releaseLoads());
      await page.getByText("Unsicher: an „Eingang prüfen“").waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[role="row"][data-log-outcome]').length === 1);
      expect(await page.getByText(/Ältere Anfrage/).count()).toBe(0);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("the detail takes focus, closing returns it to the row, and the entry stays in the URL state", async () => {
    const page = await open(desktop, { locale: "de", scenario: "normal" });
    try {
      const trigger = page.getByRole("button", { name: /Fehldruck Tüten/ });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const heading = page.locator("[data-mail-automation-log-detail] h2");
      await heading.waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === "H2");
      const opened = await page.evaluate(() => window.viewChanges.at(-1));
      expect(opened?.entry).toBe("00000000-0000-4000-8000-000000000104");
      await page.locator("[data-mail-automation-log-detail]").getByRole("button", { name: "Schließen" }).click();
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-log-open") === true);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Fehldruck Tüten");
      expect(await page.evaluate(() => window.viewChanges.at(-1)?.entry)).toBeNull();
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("As CLI shows the same view as commands", async () => {
    const page = await open(desktop, { locale: "en", scenario: "normal" });
    try {
      await page.getByRole("button", { name: "As CLI" }).click();
      await page
        .locator("[data-mail-automation-log-cli]")
        .getByText("cld mail automation log --mailbox Vertrieb --day 2026-10-26")
        .waitFor();
      // A search with shell syntax is quoted, so pasting it never runs anything.
      await page.getByRole("button", { name: "Search the log" }).click();
      await page.getByRole("searchbox", { name: "Search the log" }).fill("$(id) it's");
      await page.getByRole("searchbox", { name: "Search the log" }).press("Enter");
      await page.locator("[data-mail-automation-log-cli]").getByText(`--q '$(id) it'\\''s'`).waitFor();
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
