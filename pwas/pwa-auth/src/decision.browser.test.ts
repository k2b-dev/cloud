import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../packages/ui/test/browser";
import { solid } from "../scripts/build";
import { iconStyles } from "../scripts/icons";

// The request and its ending share one grid cell, so the sign-in sheet keeps its height when an ending replaces
// the request. Only a real engine resolves that geometry from the shipped styles, in a sheet and in a dialog.

const entry = resolve(import.meta.dir, "decision.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Clouds } from "./Clouds";
const createdAt = "2026-10-24T07:14:00.000Z";
const expiresAt = "2026-10-24T07:19:00.000Z";
window.openDecision = ({ locale, fail }) => {
  const [now, setNow] = createSignal(Date.parse("2026-10-24T07:15:00.000Z"));
  window.expire = () => setNow(Date.parse(expiresAt));
  const request = { requestId: "login", comparison: "623775", challenge: "unused", createdAt, expiresAt };
  const binding = { id: "fixture", label: "Hoffmann Druck", name: "Hoffmann", issuer: "https://cloud.hoffmann-druck.test", deviceId: "device", key: {} };
  const noop = async () => {};
  const auth = {
    bindings: () => [binding],
    states: () => ({ fixture: { requests: [request], actions: [], moreActions: 0 } }),
    now,
    online: () => true,
    storageError: () => false,
    changed: noop,
    client: noop,
    stored: async () => undefined,
    account: noop,
    action: noop,
    act: noop,
    decide: async () => {
      if (fail) throw new Error("The response was lost");
    },
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
  const preferences = { locale: () => locale, language: () => locale, theme: () => "light", setLanguage() {}, setTheme() {} };
  render(() => createComponent(Clouds, { auth, preferences }), document.getElementById("root"));
};
`;
const built = await Bun.build({
  entrypoints: [entry, resolve(import.meta.dir, "styles.css")],
  files: { [entry]: fixture },
  target: "browser",
  format: "iife",
  conditions: ["browser"],
  plugins: [solid],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!built.success) throw new AggregateError(built.logs, "Could not bundle the decision fixture.");
const script = await built.outputs.find((output) => output.path.endsWith(".js"))!.text();
const css = (await built.outputs.find((output) => output.path.endsWith(".css"))!.text()) + (await iconStyles(script));

declare global {
  interface Window {
    openDecision: (options: { locale: "en" | "de"; fail: boolean }) => void;
    expire: () => void;
  }
}

const views: Record<string, BrowserContextOptions> = {
  "iPhone 390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  "iPad 1194x834": { viewport: { width: 1194, height: 834 }, hasTouch: true },
  "iPad 834x1194": { viewport: { width: 834, height: 1194 }, hasTouch: true },
};
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const settled = (page: Page) =>
  page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const { top, height, width } = el.getBoundingClientRect();
    return { top, height, width };
  });

async function open(page: Page, locale: "en" | "de", theme: "light" | "dark", fail: boolean) {
  await page.goto("https://login.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((theme) => {
    document.body.dataset.theme = theme;
  }, theme);
  // The first frame of the sheet, before its entrance settles, already has the final height.
  const first = await page.evaluate(
    (options) =>
      new Promise<string>((done) => {
        window.openDecision(options);
        const measure = () => {
          const dialog = document.querySelector("dialog[open]");
          // The layout height, not the box: the entrance transform is still running.
          if (dialog) done(getComputedStyle(dialog.querySelector(".auth-decision")!).height);
          else requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      }),
    { locale, fail },
  );
  await settled(page);
  return first;
}

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`;

describe("sign-in sheet", () => {
  for (const [name, view] of Object.entries(views)) {
    for (const theme of ["light", "dark"] as const) {
      for (const locale of ["en", "de"] as const) {
        for (const ending of ["expired", "uncertain"] as const) {
          test(`shows the start time and keeps its height when it ends ${ending}, ${name} ${theme} ${locale}`, async () => {
            const context = await browser.newContext({ ...view, timezoneId: "Europe/Vienna", colorScheme: theme });
            try {
              const tab = await context.newPage();
              await tab.route("https://login.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
              const errors: string[] = [];
              tab.on("pageerror", (error) => errors.push(error.message));
              const first = await open(tab, locale, theme, ending === "uncertain");
              const dialog = await box(tab, "dialog[open]");
              const cell = await box(tab, ".auth-decision");
              expect(first).toBe(await tab.locator(".auth-decision").evaluate((el) => getComputedStyle(el).height));
              expect(await tab.locator(".auth-decision__started").textContent()).toBe(
                locale === "de" ? "Gestartet um 09:14" : "Started at 09:14",
              );
              // The line sits inside the request, above the code, and fits on one row.
              const line = await box(tab, ".auth-decision__started");
              const code = await box(tab, ".auth-comparison");
              expect(line.top).toBeGreaterThanOrEqual(cell.top);
              expect(line.top + line.height).toBeLessThan(code.top);
              expect(line.height).toBeLessThan(32);
              if (ending === "expired") await tab.evaluate(() => window.expire());
              else
                await tab
                  .locator(".auth-decision-actions__choices button")
                  .filter({ hasText: locale === "de" ? "Anmeldung erlauben" : "Approve sign-in" })
                  .click();
              await tab.locator(`.auth-action-result[data-outcome="${ending}"]`).waitFor();
              await settled(tab);
              expect(await box(tab, ".auth-decision")).toEqual(cell);
              expect(await box(tab, "dialog[open]")).toEqual(dialog);
              expect(await tab.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
              expect(errors).toEqual([]);
            } finally {
              await context.close();
            }
          });
        }
      }
    }
  }
});
