import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../../packages/ui/test/browser";
import { solid } from "../scripts/build";
import { iconStyles } from "../scripts/icons";

// A device-change request and its ending share one grid cell, and its consequence and the offline reason share
// one place, so the sheet keeps its size from the first frame through every ending. Only a real engine resolves
// that geometry from the shipped styles, in a sheet and in a dialog. CLOUD_APPROVAL_SHOTS=<dir> also saves each
// request and its ending.
const shots = process.env.CLOUD_APPROVAL_SHOTS;

const entry = resolve(import.meta.dir, "change.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Clouds } from "./Clouds";
const createdAt = "2026-10-24T07:14:00.000Z";
const expiresAt = "2026-10-24T07:19:00.000Z";
window.openChange = ({ locale, kind, self, name, outcome }) => {
  const [now, setNow] = createSignal(Date.parse("2026-10-24T07:15:00.000Z"));
  const [online, setOnline] = createSignal(true);
  window.expire = () => setNow(Date.parse(expiresAt));
  window.offline = () => setOnline(false);
  const binding = { id: "fixture", label: "Hoffmann Druck", name: "Hoffmann", issuer: "https://cloud.hoffmann-druck.test", deviceId: "device", key: {} };
  const change = {
    changeId: "change",
    kind,
    device: { id: self ? binding.deviceId : "target", name },
    endSessions: kind === "revoke",
    createdAt,
    expiresAt,
  };
  const noop = async () => {};
  const auth = {
    bindings: () => [binding],
    states: () => ({ fixture: { requests: [], changes: [change], actions: [], moreChanges: 0, moreActions: 0 } }),
    now,
    online,
    storageError: () => false,
    changed: noop,
    client: noop,
    stored: async () => undefined,
    account: noop,
    action: noop,
    act: noop,
    decide: noop,
    decideChange: async () => {
      if (outcome === "uncertain") throw new Error("The response was lost");
      if (outcome === "stale") throw new Error("stale");
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
if (!built.success) throw new AggregateError(built.logs, "Could not bundle the device-change fixture.");
const script = await built.outputs.find((output) => output.path.endsWith(".js"))!.text();
const css = (await built.outputs.find((output) => output.path.endsWith(".css"))!.text()) + (await iconStyles(script));

type Scenario = {
  kind: "pair" | "revoke";
  self?: boolean;
  /** How the request ends: a decision with its answer, its expiry, or going offline. */
  end: "approve" | "deny" | "uncertain" | "stale" | "expired" | "offline";
};
type Options = { locale: "en" | "de"; kind: Scenario["kind"]; self: boolean; name: string; outcome: Scenario["end"] };

declare global {
  interface Window {
    openChange: (options: Options) => void;
    expire: () => void;
    offline: () => void;
  }
}

const views: Record<string, BrowserContextOptions> = {
  "iPhone 390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  "iPad 1194x834": { viewport: { width: 1194, height: 834 }, hasTouch: true },
  "iPad 834x1194": { viewport: { width: 834, height: 1194 }, hasTouch: true },
};
const scenarios: Record<string, Scenario> = {
  "pairing approved": { kind: "pair", end: "approve" },
  "removal denied": { kind: "revoke", end: "deny" },
  "own removal approved": { kind: "revoke", self: true, end: "approve" },
  "removal with a lost answer": { kind: "revoke", end: "uncertain" },
  "removal decided elsewhere": { kind: "revoke", end: "stale" },
  "pairing expired": { kind: "pair", end: "expired" },
  "removal offline": { kind: "revoke", end: "offline" },
};
// The longest name Cloud sends, without spaces, so it can only wrap anywhere.
const name = "Ö".repeat(80);

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
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

async function open(page: Page, theme: "light" | "dark", options: Options) {
  await page.goto("https://login.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((theme) => {
    document.body.dataset.theme = theme;
  }, theme);
  // settled: the first frame of the sheet, before its entrance settles, is the subject; it already has the final height.
  const first = await page.evaluate(
    (options) =>
      new Promise<string>((done) => {
        window.openChange(options);
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
  return first;
}

const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`;

describe("device-change sheet", () => {
  for (const [viewName, view] of Object.entries(views)) {
    for (const theme of ["light", "dark"] as const) {
      for (const locale of ["en", "de"] as const) {
        for (const [scenarioName, scenario] of Object.entries(scenarios)) {
          test(`keeps its size when the ${scenarioName} ends, ${viewName} ${theme} ${locale}`, async () => {
            const context = await browser.newContext({ ...view, colorScheme: theme });
            try {
              const tab = await context.newPage();
              await tab.route("https://login.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
              const errors: string[] = [];
              tab.on("pageerror", (error) => errors.push(error.message));
              const first = await open(tab, theme, {
                locale,
                kind: scenario.kind,
                self: scenario.self === true,
                name,
                outcome: scenario.end,
              });
              const dialog = await box(tab, "dialog[open]");
              const cell = await box(tab, ".auth-decision");
              const note = await box(tab, ".auth-change-note");
              expect(first).toBe(await tab.locator(".auth-decision").evaluate((el) => getComputedStyle(el).height));
              // The device row keeps its name inside the sheet, however long it is.
              const device = await box(tab, ".auth-change-device");
              expect(device.width).toBeLessThanOrEqual(cell.width);
              const shot = (state: string) =>
                shots
                  ? tab.screenshot({
                      path: join(
                        shots,
                        `change-${scenarioName.replaceAll(" ", "-")}-${state}-${viewName.replaceAll(" ", "-")}-${theme}-${locale}.png`,
                      ),
                    })
                  : undefined;
              await shot("request");
              const choices = tab.locator(".auth-decision-actions__choices button");
              // A device asked to remove itself can leave the request open, but not deny it.
              expect(await choices.first().textContent()).toBe(
                scenario.self ? (locale === "de" ? "Nicht jetzt" : "Not now") : locale === "de" ? "Ablehnen" : "Deny",
              );
              if (scenario.end === "expired") await tab.evaluate(() => window.expire());
              else if (scenario.end === "offline") await tab.evaluate(() => window.offline());
              else {
                // The choices stay inert for a moment after opening, so a tap meant for the page behind never decides.
                await tab.waitForFunction(() => !document.querySelector(".auth-decision-actions__choices")?.hasAttribute("inert"));
                await choices.nth(scenario.end === "deny" ? 0 : 1).click();
              }
              if (scenario.end === "offline") {
                await tab.locator(".auth-change-note[data-offline] [role=status]").filter({ hasText: /\S/ }).waitFor();
                expect(await choices.nth(1).isDisabled()).toBe(true);
                expect(await box(tab, ".auth-change-note")).toEqual(note);
              } else {
                await tab.locator(`.auth-action-result[data-outcome="${scenario.end}"]`).waitFor();
              }
              await settled(tab);
              await shot("ended");
              // Every line of the request and its ending wraps inside the sheet, even a name without spaces.
              expect(
                await tab
                  .locator(".auth-decision")
                  .evaluate((cell) => [...cell.querySelectorAll("p, h3, strong")].every((el) => el.scrollWidth <= el.clientWidth + 1)),
              ).toBe(true);
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
