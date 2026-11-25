import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";
import { adminV2BrowserFixture } from "./admin-v2.browser-fixture";

// The overview, announcements and Apps › Navigation on v2: each keeps the layout rules at every width, an announcement
// is created and deleted from its form beside the list, and a shortcut moves and saves the whole bar.
setDefaultTimeout(15_000);
let browser: Browser;
let fixture: Awaited<ReturnType<typeof adminV2BrowserFixture>>;
let page: Page;
let errors: string[];

const goto = async (path: string, width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}${path}${path.includes("?") ? "&" : "?"}locale=de`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
};
const button = (name: string) => page.locator("main").getByRole("button", { name, exact: true }).filter({ visible: true });
const sent = (method: string, path: string) => fixture.requests.filter((request) => request.method === method && request.path === path);

beforeAll(async () => {
  fixture = await adminV2BrowserFixture();
  browser = await launchBrowser();
}, 120_000);
beforeEach(async () => {
  if (page) await page.close();
  fixture.reset();
  page = await browser.newPage();
  errors = pageErrors(page);
});
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

test("each screen keeps the v2 rules at every width, with no loader in the first picture", async () => {
  const paths = [
    "/admin",
    "/admin/announcements",
    "/admin/announcements?entry=aaaaaaaa-0000-4000-8000-000000000001",
    "/admin/apps/navigation",
    "/admin/apps/navigation?shortcut=bbbbbbbb-0000-4000-8000-000000000001",
  ];
  for (const path of paths)
    for (const width of [1440, 1024, 390]) {
      await goto(path, width);
      // The v1 icon picker stands in for a missing v2 one (k2b-ui gap) and is not measured.
      const problems = (await measureV2Layout(page, { root: "main.k2-ui", skip: ".k2b-field" })).problems;
      expect({ path, width, problems }).toEqual({ path, width, problems: [] });
      expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  expect(errors).toEqual([]);
}, 120_000);

test("the overview leads to every place with a row", async () => {
  await goto("/admin");
  expect(
    await page
      .locator("main")
      .getByRole("link", { name: /System untersuchen/ })
      .getAttribute("href"),
  ).toBe("/admin/observability");
  expect(
    await page
      .locator("main")
      .getByRole("link", { name: /Speicher/ })
      .first()
      .getAttribute("href"),
  ).toBe("/admin/storage");
  expect(errors).toEqual([]);
});

test("a new announcement needs a title and text, then saves; deleting one asks first", async () => {
  await goto("/admin/announcements?entry=new");
  await button("Erstellen").click();
  expect(await page.locator("main").getByText("Pflichtfeld.").count()).toBe(2);
  expect(sent("POST", "/api/admin/core/announcements")).toHaveLength(0);
  await page
    .locator("main")
    .getByRole("textbox", { name: /^Titel/ })
    .fill("Neue Funktion");
  await page
    .locator("main")
    .getByRole("textbox", { name: /^Inhalt/ })
    .fill("Ab heute gibt es Kalender.");
  await button("Erstellen").click();
  await page.waitForFunction(() => !location.search.includes("entry="));
  expect(sent("POST", "/api/admin/core/announcements")[0]?.body).toMatchObject({
    kind: "announcement",
    title: "Neue Funktion",
    tone: "info",
  });

  await goto("/admin/announcements?entry=aaaaaaaa-0000-4000-8000-000000000002");
  await button("Löschen").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect(sent("DELETE", "/api/admin/core/announcements/aaaaaaaa-0000-4000-8000-000000000002")).toHaveLength(0);
  await button("Löschen").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Löschen", exact: true }).click();
  await page.waitForFunction(() => !location.search.includes("entry="));
  expect(sent("DELETE", "/api/admin/core/announcements/aaaaaaaa-0000-4000-8000-000000000002")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a shortcut moves down and saves the whole bar with its revision", async () => {
  await goto("/admin/apps/navigation?shortcut=bbbbbbbb-0000-4000-8000-000000000001");
  await page.locator("main").getByRole("button", { name: "Nach unten" }).click();
  await page.waitForFunction(() => document.querySelector('main [aria-busy="true"]') === null);
  const [put] = sent("PUT", "/api/admin/core/rail");
  const body = put?.body as { revision: number; entries: { shortcut: { id: string } }[] };
  expect(body.revision).toBe(4);
  expect(body.entries.map((entry) => entry.shortcut.id)).toEqual([
    "bbbbbbbb-0000-4000-8000-000000000002",
    "bbbbbbbb-0000-4000-8000-000000000001",
  ]);
  expect(errors).toEqual([]);
});
