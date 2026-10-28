import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../packages/ui/test/browser";
import { type DecisionAnswer, type DecisionState, decisionPage } from "./decision.browser-harness";

// The request and its ending share one grid cell, so the sign-in sheet keeps its height when an ending replaces
// the request. Only a real engine resolves that geometry from the shipped styles, in a sheet and in a dialog.

const { script, html } = await decisionPage();

const views: Record<string, BrowserContextOptions> = {
  "iPhone 390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  "iPad 1194x834": { viewport: { width: 1194, height: 834 }, hasTouch: true },
  "iPad 834x1194": { viewport: { width: 834, height: 1194 }, hasTouch: true },
};
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
  // The engine's first sheet happens here, in the launch budget: in WebKit, the first entrance animation took
  // about 3 s to settle under load and pushed whichever test ran first past its 5 s budget.
  const warm = await browser.newContext();
  try {
    await warm.route("https://login.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
    const page = await warm.newPage();
    await page.goto("https://login.test/");
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.openDecision({ locale: "de", state: "known", answer: "ok" }));
    await page.locator("dialog[open]").waitFor();
    await settled(page);
  } finally {
    await warm.close();
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.timeline === document.timeline)
      .every((animation) => animation.playState !== "running"),
  );
const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => {
    const { top, height, width } = el.getBoundingClientRect();
    return { top, height, width };
  });

async function open(
  page: Page,
  options: { locale: "en" | "de"; theme: "light" | "dark"; state: DecisionState; answer: DecisionAnswer; css?: string },
) {
  await page.goto("https://login.test/");
  await page.addScriptTag({ content: script });
  if (options.css) await page.addStyleTag({ content: options.css });
  await page.evaluate((theme) => {
    document.body.dataset.theme = theme;
  }, options.theme);
  // The first frame of the sheet, before its entrance settles, already has the final height.
  const first = await page.evaluate(
    ({ locale, state, answer }) =>
      new Promise<string>((done) => {
        window.openDecision({ locale, state, answer });
        const measure = () => {
          const dialog = document.querySelector("dialog[open]");
          // The layout height, not the box: the entrance transform is still running.
          if (dialog) done(getComputedStyle(dialog.querySelector(".auth-decision")!).height);
          else requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      }),
    options,
  );
  await settled(page);
  expect(first).toBe(await page.locator(".auth-decision").evaluate((el) => getComputedStyle(el).height));
}

/** One context per view and theme; each test gets a fresh page in it and checks it for overflow and errors. */
function sharedContext(view: BrowserContextOptions, theme: "light" | "dark") {
  let context: BrowserContext;
  beforeAll(async () => {
    context = await browser.newContext({ ...view, timezoneId: "Europe/Vienna", colorScheme: theme });
    await context.route("https://login.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  });
  afterAll(async () => {
    await context?.close();
  });
  return async (run: (page: Page) => Promise<void>) => {
    const page = await context.newPage();
    try {
      const errors = pageErrors(page);
      await run(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  };
}

/** Every part of the sheet whose place must not move while the request changes phase. */
const places = async (page: Page) => ({
  dialog: await box(page, "dialog[open]"),
  cell: await box(page, ".auth-decision"),
  footer: await box(page, ".auth-decision-actions"),
  buttons: await page.locator(".auth-decision-actions__choices button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const { top, left, height, width } = button.getBoundingClientRect();
      return { top, left, height, width };
    }),
  ),
});

const states: DecisionState[] = [
  "known",
  "first",
  "country",
  "since",
  "network",
  "nogeo",
  "sparse",
  "noplace",
  "intro",
  "warn",
  "warnSince",
  "legacy",
];

describe("sign-in sheet", () => {
  for (const [name, view] of Object.entries(views)) {
    for (const theme of ["light", "dark"] as const) {
      describe(`${name} ${theme}`, () => {
        const withPage = sharedContext(view, theme);
        for (const state of states) {
          test(`shows who asks above the code, ${state}`, async () => {
            await withPage(async (page) => {
              await open(page, { locale: "de", theme, state, answer: "ok" });
              const rows = page.locator(".auth-decision__details[data-context] dd");
              const code = await box(page, ".auth-comparison");
              const footer = await box(page, ".auth-decision-actions");
              const hint = await box(page, ".auth-decision__hint");
              // The code stays the largest text and stands directly above the buttons.
              const largest = await page
                .locator(".auth-decision__request")
                .evaluate((request) =>
                  Math.max(
                    ...[...request.querySelectorAll("p, dd, .k2b-notice-card")].map((el) =>
                      Number.parseFloat(getComputedStyle(el).fontSize),
                    ),
                  ),
                );
              expect(
                Number.parseFloat(await page.locator(".auth-comparison").evaluate((el) => getComputedStyle(el).fontSize)),
              ).toBeGreaterThan(largest * 2);
              expect(hint.top + hint.height).toBeLessThanOrEqual(code.top);
              expect(code.top + code.height).toBeLessThanOrEqual(footer.top);
              if (state === "legacy") {
                expect(await rows.count()).toBe(0);
                expect(await page.locator(".auth-decision__started").textContent()).toBe("Gestartet um 09:14");
                return;
              }
              // Each row is one line next to its icon, with nothing cut off; measured in one round trip.
              const measured = await rows.evaluateAll((dds) =>
                dds.map((dd) => ({
                  text: dd.textContent,
                  height: dd.getBoundingClientRect().height,
                  fits: dd.scrollWidth <= dd.clientWidth,
                })),
              );
              for (const row of measured) {
                expect(row.height, `${state} ${row.text}`).toBeLessThan(32);
                expect(row.fits, `${state} ${row.text}`).toBe(true);
              }
              const last = await box(page, ".auth-decision__details[data-context]");
              const note = page.locator(".auth-decision__request > .k2b-notice-card");
              const below = (await note.count()) ? await box(page, ".auth-decision__request > .k2b-notice-card") : hint;
              expect(last.top + last.height).toBeLessThanOrEqual(below.top);
            });
          });
        }

        for (const locale of ["en", "de"] as const) {
          // Denied, expired and not confirmed replace a warned request in the same cell, at the same height.
          for (const [answer, ending] of [
            ["ok", "denied"],
            ["ok", "expired"],
            ["lost", "uncertain"],
          ] as const) {
            test(`a warned request ends ${ending} in place, ${locale}`, async () => {
              await withPage(async (page) => {
                await open(page, { locale, theme, state: "warn", answer });
                const before = await places(page);
                if (ending === "expired") await page.evaluate(() => window.expire());
                else
                  await page
                    .locator(".auth-decision-actions__choices button")
                    .nth(ending === "denied" ? 0 : 1)
                    .click();
                await page.locator(`.auth-decision > .auth-action-result[data-outcome="${ending}"]`).waitFor();
                await settled(page);
                const after = await places(page);
                expect(after.dialog).toEqual(before.dialog);
                expect(after.cell).toEqual(before.cell);
                expect(after.footer).toEqual(before.footer);
              });
            });
          }
          // The earlier sheet of a Cloud without login context: the start time, and the same height after it ends.
          for (const ending of ["expired", "uncertain"] as const) {
            test(`without login context, shows the start time and keeps its height when it ends ${ending}, ${locale}`, async () => {
              await withPage(async (tab) => {
                await open(tab, { locale, theme, state: "legacy", answer: ending === "uncertain" ? "lost" : "ok" });
                const dialog = await box(tab, "dialog[open]");
                const cell = await box(tab, ".auth-decision");
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
              });
            });
          }
        }

        test("offline and sending keep every place of a warned request", async () => {
          await withPage(async (page) => {
            // Offline swaps the code hint for the reason in place; sending keeps both buttons where they are.
            await open(page, { locale: "de", theme, state: "warn", answer: "hang" });
            const online = { ...(await places(page)), code: await box(page, ".auth-comparison") };
            await page.evaluate(() => window.setOnline(false));
            await page.locator(".auth-decision__hint[data-offline]").waitFor();
            expect({ ...(await places(page)), code: await box(page, ".auth-comparison") }).toEqual(online);
            await page.evaluate(() => window.setOnline(true));
            await page.locator(".auth-decision__hint:not([data-offline])").waitFor();
            await page.locator(".auth-decision-actions__choices button").first().click();
            await page.locator(".auth-decision-actions__choices button[aria-busy='true']").waitFor();
            expect({ ...(await places(page)), code: await box(page, ".auth-comparison") }).toEqual(online);
          });
        });

        test("a later poll with a different same-network answer adds no line", async () => {
          await withPage(async (page) => {
            await open(page, { locale: "de", theme, state: "known", answer: "ok" });
            const known = await places(page);
            const lines = await page.locator(".auth-decision__details[data-context] dd").allTextContents();
            await page.evaluate(() => window.refresh());
            await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
            expect(await page.locator(".auth-decision__details[data-context] dd").allTextContents()).toEqual(lines);
            expect(await places(page)).toEqual(known);
          });
        });
      });
    }
  }

  describe("large text", () => {
    const withPage = sharedContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true }, "light");
    test("the sheet stays inside the screen, its content scrolls and the buttons stay", async () => {
      await withPage(async (page) => {
        await open(page, { locale: "de", theme: "light", state: "warn", answer: "ok", css: "html { font-size: 175%; }" });
        const dialog = await box(page, "dialog[open]");
        expect(dialog.top).toBeGreaterThanOrEqual(0);
        expect(dialog.top + dialog.height).toBeLessThanOrEqual(664);
        const footer = await box(page, ".auth-decision-actions");
        expect(footer.top + footer.height).toBeLessThanOrEqual(664);
        const body = page.locator("dialog[open] .k2b-panel-dialog__body");
        expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
        await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        expect(await box(page, ".auth-decision-actions")).toEqual(footer);
        expect(await page.locator(".auth-comparison").isVisible()).toBe(true);
      });
    });
  });
});
