import { afterAll, beforeAll, expect, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../ui/test/browser";
import {
  MAINTENANCE_FIXTURE_BYPASS_COOKIE,
  MAINTENANCE_FIXTURE_NOW,
  maintenanceBrowserFixture,
  pinPageClock,
} from "./Maintenance.browser-fixture";

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
const open = async (view: { width: number; height: number }, query: string, holdsBypass = !query.includes("state=aus")) => {
  const page = await browser.newPage({ viewport: view, reducedMotion: "reduce", isMobile: view.width < 600, hasTouch: view.width < 600 });
  const errors = pageErrors(page);
  // An admin on a running maintenance already holds the gateway's bypass cookie; one that starts it earns it.
  if (holdsBypass) await page.context().addCookies([{ ...MAINTENANCE_FIXTURE_BYPASS_COOKIE, url: new URL(fixture.url).origin }]);
  await page.addInitScript(pinPageClock, MAINTENANCE_FIXTURE_NOW.getTime());
  await page.goto(`${fixture.url}?${query}`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
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
          const text = (await page.locator('main [data-k2-part="Pane"]').innerText()).replace(/\s+/g, " ");
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

const gatewayStatus = (page: Page) =>
  page.evaluate(async (): Promise<unknown> => (await fetch("/_cloud/gateway/status", { cache: "no-store" })).json());

test("starting lets this browser past the wall: the gateway confirms the bypass and the reload shows the running maintenance", async () => {
  // The address names no scenario, so the reload shows whatever the fixture's Core and gateway hold by then.
  fixture.use("aus");
  const { page, errors } = await open(views[1], "locale=de", false);
  try {
    fixture.control.requests.length = 0;
    const loads: string[] = [];
    page.on("load", () => loads.push(page.url()));
    await page.getByLabel("Hinweis für alle").fill("Wir spielen Version 2.4 ein.");
    const reloaded = page.waitForEvent("load", { timeout: 10_000 });
    await page.getByRole("button", { name: "Wartung starten", exact: true }).click();
    await reloaded;
    await page.getByRole("button", { name: "Wartung beenden", exact: true }).waitFor();
    // The reload passed the wall: the server rendered the running maintenance for a browser the gateway lets in.
    expect(await page.locator("[data-maintenance-wall]").count()).toBe(0);
    // The fixture gateway confirms only for a browser holding its HttpOnly cookie, which the page's script cannot set.
    expect(await gatewayStatus(page)).toEqual({ maintenance: { active: true, until: null, bypass: true } });
    const calls = fixture.control.requests.map((request) => `${request.method} ${request.path}`);
    expect(calls).toEqual([
      "POST /api/admin/maintenance/on",
      "POST /api/admin/maintenance/bypass",
      "GET /admin/settings/maintenance?cloud-maintenance-bypass",
      "GET /_cloud/gateway/status",
      "GET /admin/settings/maintenance",
      "GET /_cloud/gateway/status",
    ]);
    // The browser stayed on this page and reloaded it once.
    expect(loads).toEqual([fixture.url + "?locale=de"]);
    const text = await page.locator('main [data-k2-part="Pane"]').innerText();
    expect(text).toContain("Alle außer dir sehen gerade die Wartungsseite.");
    // The suggested end, one hour ahead and rounded up to the quarter hour.
    expect(text).toContain("15:15 Uhr");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("when the gateway never confirms the bypass, the page says so and stays: no reload, no endless asking", async () => {
  fixture.use("aus");
  const { page, errors } = await open(views[0], "locale=de", false);
  fixture.control.gatewayKnowsMaintenance = false;
  try {
    fixture.control.requests.length = 0;
    const loads: string[] = [];
    page.on("load", () => loads.push(page.url()));
    await page.getByRole("button", { name: "Wartung starten", exact: true }).click();
    const notice = page.locator('main [data-k2-part="Notice"]');
    await notice.waitFor({ timeout: 10_000 });
    expect(await notice.innerText()).toContain("Die Wartung läuft, aber dein Link an der Wartungsseite vorbei ließ sich nicht erstellen.");
    const text = await page.locator('main [data-k2-part="Pane"]').innerText();
    expect(text).toContain("Alle sehen gerade die Wartungsseite, du ab dem nächsten Laden auch.");
    expect(await notice.getByRole("button", { name: "Erneut versuchen", exact: true }).isVisible()).toBe(true);
    // Bounded: fifteen link-and-status rounds, then nothing more, and the page never reloaded into the wall.
    const linkRequests = () => fixture.control.requests.filter((request) => request.path.endsWith("?cloud-maintenance-bypass")).length;
    expect(linkRequests()).toBe(15);
    await page.waitForTimeout(600);
    expect(linkRequests()).toBe(15);
    expect(loads).toEqual([]);
    expect(await gatewayStatus(page)).toEqual({ maintenance: { active: true, until: null } });
    expect(errors).toEqual([]);
  } finally {
    fixture.control.gatewayKnowsMaintenance = true;
    await page.close();
  }
}, 60_000);

test("the end moves past midnight with the date-time picker, which names the time zone", async () => {
  const { page, errors } = await open(views[0], "state=aktiv&locale=de");
  try {
    fixture.control.requests.length = 0;
    await page.getByRole("button", { name: "Ende verschieben", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator(".k2b-date-trigger").click();
    await page.locator(".k2b-date-popover__timezone", { hasText: "Europe/Berlin" }).waitFor();
    await page.locator('[data-date-day="2026-11-17"]').click();
    await page.locator(".k2b-date-time__control input").fill("01:30");
    await page.getByRole("button", { name: "Übernehmen", exact: true }).click();
    await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const saved = fixture.control.requests.find((request) => request.path === "/api/admin/maintenance/until");
    expect(JSON.parse(saved?.body ?? "{}")).toEqual({ until: "2026-11-17T00:30:00.000Z" });
    expect(await page.locator('main [data-k2-part="Pane"]').innerText()).toMatch(/17\.\s?Nov\.?\s2026,\s01:30 Uhr/);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("ending asks first: cancel changes nothing, the v2 layout holds in both states", async () => {
  for (const state of ["aus", "aktiv"])
    for (const width of [1440, 1024, 390]) {
      const { page } = await open({ width, height: 900 }, `state=${state}&locale=de`);
      try {
        expect({ state, width, problems: (await measureV2Layout(page, { root: "main.k2-ui" })).problems }).toEqual({
          state,
          width,
          problems: [],
        });
      } finally {
        await page.close();
      }
    }
  const { page, errors } = await open(views[0], "state=aktiv&locale=de");
  try {
    fixture.control.requests.length = 0;
    await page.getByRole("button", { name: "Wartung beenden", exact: true }).click();
    const question = page.getByRole("alertdialog");
    expect(await question.innerText()).toContain("Wartung beenden?");
    await question.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await question.waitFor({ state: "detached" });
    expect(fixture.control.requests.filter((request) => request.path === "/api/admin/maintenance/off")).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
