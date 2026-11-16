import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import {
  MAINTENANCE_NOTICE_REPLY,
  MAINTENANCE_NOTICE_SCENARIOS,
  type MaintenanceNoticeScenario,
  maintenanceNoticeBrowserFixture,
} from "./maintenance-notice.browser-fixture";

// The notice is a floating @k2b/ui toast inside the real shell: only a real engine shows that it keeps the reply the
// person is typing, moves nothing on the page, and fits a phone without sideways scrolling.
let browser: Browser;
let fixture: Awaited<ReturnType<typeof maintenanceNoticeBrowserFixture>>;
beforeAll(async () => {
  fixture = await maintenanceNoticeBrowserFixture();
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

const open = async (view: { width: number; height: number }, scenario: MaintenanceNoticeScenario) => {
  const phone = view.width < 600;
  const page = await browser.newPage({ viewport: view, reducedMotion: "reduce", isMobile: phone, hasTouch: phone });
  page.setDefaultTimeout(10_000);
  const errors = pageErrors(page);
  await page.goto(fixture.url(scenario));
  await page.locator('#maintenance-notice-fixture[data-ready="true"]').waitFor();
  return { page, errors };
};

const notice = (page: Page) => page.locator("[data-k2b-toast]:not([data-closing])");

/** What each state says, in the order of the approved mockup; the bypass notice follows the decision of section 5. */
const expected: Record<MaintenanceNoticeScenario, string[]> = {
  vorher: [],
  "app-updating": [
    "Mail wird gerade aktualisiert",
    "Deine Eingaben bleiben hier. Speichern und Senden ist nach der Aktualisierung möglich.",
  ],
  maintenance: ["Wartungsmodus aktiv", "Deine Eingaben bleiben hier. Speichern und Senden ist nach der Wartung möglich."],
  done: ["Aktualisierung abgeschlossen", "Du kannst jetzt wieder speichern und senden."],
  "bypass-admin": ["Wartungsmodus aktiv", "Nur du siehst die Cloud.", "Wartung beenden"],
};

test("each state shows its notice over the reply without moving the form, on a desktop and a phone", async () => {
  for (const view of views)
    for (const scenario of MAINTENANCE_NOTICE_SCENARIOS) {
      const { page, errors } = await open(view, scenario);
      try {
        const where = { scenario, width: view.width };
        if (scenario === "vorher") {
          await page.locator('#maintenance-notice-fixture[data-thread-loaded="true"]').waitFor();
          expect({ ...where, notices: await notice(page).count() }).toEqual({ ...where, notices: 0 });
        } else {
          // `done` passes through the update notice; the next status check finishes it in place.
          await notice(page).filter({ hasText: expected[scenario][0] }).waitFor();
          const text = (await notice(page).innerText()).replace(/\s+/g, " ");
          for (const part of expected[scenario]) expect({ ...where, text: text.includes(part) }).toEqual({ ...where, text: true });
        }
        if (scenario === "done") await page.locator('#maintenance-notice-fixture[data-thread-loaded="true"]').waitFor();
        expect(await page.getByLabel("Antwort").inputValue()).toBe(MAINTENANCE_NOTICE_REPLY);
        const layout = await page.evaluate(() => {
          const root = document.querySelector<HTMLElement>("#maintenance-notice-fixture")!;
          const box = root.querySelector("[data-reply-form]")!.getBoundingClientRect();
          return {
            overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            before: JSON.parse(root.dataset.formBox!) as number[],
            after: [box.left, box.top, box.width, box.height],
          };
        });
        expect({ ...where, overflow: layout.overflow, form: layout.after }).toEqual({ ...where, overflow: 0, form: layout.before });
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
}, 120_000);

test("a send during maintenance keeps the reply and says why, and nothing sends it later by itself", async () => {
  const { page, errors } = await open(views[1], "maintenance");
  try {
    await notice(page).filter({ hasText: "Wartungsmodus aktiv" }).waitFor();
    fixture.control.requests.length = 0;
    await page.getByRole("button", { name: "Senden", exact: true }).click();
    await page
      .locator("[data-send-result]", { hasText: "Wartungsmodus aktiv. Das geht wieder, sobald die Wartung beendet ist." })
      .waitFor();
    expect(await page.getByLabel("Antwort").inputValue()).toBe(MAINTENANCE_NOTICE_REPLY);
    expect(fixture.control.requests.filter((request) => request.startsWith("POST "))).toEqual([
      "POST /app/mail/api/threads/hallenbelegung/reply",
    ]);
    expect(await notice(page).count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);

test("an administrator past the wall ends the maintenance from the notice", async () => {
  const { page, errors } = await open(views[0], "bypass-admin");
  try {
    await notice(page).getByRole("button", { name: "Wartung beenden", exact: true }).click();
    await notice(page).filter({ hasText: "Wartung beendet" }).waitFor();
    expect((await notice(page).innerText()).replace(/\s+/g, " ")).toContain("Alle sehen die Cloud wieder.");
    expect(fixture.control.requests).toContain("POST /api/admin/maintenance/off");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
