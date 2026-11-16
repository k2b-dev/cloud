import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import { MAINTENANCE_FIXTURE_NOW, maintenanceBrowserFixture } from "./Maintenance.browser-fixture";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof maintenanceBrowserFixture>>;
beforeAll(async () => {
  fixture = await maintenanceBrowserFixture();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

const views = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const open = async (view: { width: number; height: number }, query: string) => {
  const page = await browser.newPage({ viewport: view, reducedMotion: "reduce", isMobile: view.width < 600, hasTouch: view.width < 600 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.setFixedTime(MAINTENANCE_FIXTURE_NOW);
  await page.goto(`${fixture.url}?${query}`);
  await page.locator('#maintenance-fixture[data-ready="true"]').waitFor();
  return { page, errors };
};

test("both states fit a phone and a desktop in both themes and say what the mockup says", async () => {
  for (const view of views)
    for (const theme of ["light", "dark"])
      for (const state of ["aus", "aktiv", "aktiv-knapp"]) {
        const { page, errors } = await open(view, `state=${state}&locale=de&theme=${theme}`);
        try {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect({ state, width: view.width, overflow: Math.max(0, overflow) }).toEqual({ state, width: view.width, overflow: 0 });
          const text = (await page.locator("[data-maintenance-admin]").innerText()).replace(/\s+/g, " ");
          if (state === "aus") {
            expect(text).toContain("Solange er an ist, sehen alle statt der Cloud eine Wartungsseite.");
            expect(text).not.toContain("Beginn");
          }
          if (state === "aktiv") {
            expect(text).toContain("14:02 Uhr, gestartet von Lea Muster");
            expect(text).toContain("9 von 11 · Dateien und Mail starten noch");
          }
          if (state === "aktiv-knapp") expect(text).not.toContain("Geplant bis");
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }
}, 120_000);

test("starting comes back to this page through the bypass link and shows the running maintenance", async () => {
  const { page, errors } = await open(views[1], "state=aus&locale=de");
  try {
    fixture.control.requests.length = 0;
    await page.getByLabel("Hinweis für alle").fill("Wir spielen Version 2.4 ein.");
    await page.getByLabel("Voraussichtlich fertig um").fill("14:30");
    await page.getByRole("button", { name: "Wartung starten", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/admin/settings/maintenance" && !url.search.includes("state="));
    await page.locator('[data-maintenance-admin="active"]').waitFor();
    const calls = fixture.control.requests.map((request) => `${request.method} ${request.path}`);
    expect(calls.slice(0, 2)).toEqual(["POST /api/admin/maintenance/on", "POST /api/admin/maintenance/bypass"]);
    expect(await page.locator("[data-maintenance-admin]").innerText()).toContain("14:30 Uhr");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
