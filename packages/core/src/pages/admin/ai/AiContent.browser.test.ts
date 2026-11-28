import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../ui/test/browser";
import { aiAreaBrowserFixture } from "./AiArea.browser-fixture";

// AI › Skills and Projects on v2: the lists keep the layout rules at every width (also with the worst data), an entry
// opens beside the list by its address, and every deed (delete, compare and reset, bring back an app Skill, search,
// pages) reaches its API only after the person agrees.
setDefaultTimeout(20_000);
let browser: Browser;
let fixture: Awaited<ReturnType<typeof aiAreaBrowserFixture>>;
let page: Page;
let errors: string[];

const goto = async (query: string, width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}?locale=de&${query}`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
};
const main = () => page.locator("main");
const sent = (method: string, path: string) => fixture.requests.filter((request) => request.method === method && request.path === path);

beforeAll(async () => {
  fixture = await aiAreaBrowserFixture();
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

test("Skills and Projects keep the v2 rules at every width, with no loader in the first picture", async () => {
  const paths = [
    "sec=skills",
    "sec=skills&skill=sk0004",
    "sec=skills&state=empty",
    "sec=skills&state=worst",
    "sec=skills&state=worst&skill=sk0002",
    "sec=projects",
    "sec=projects&project=pj0004",
    "sec=projects&state=worst&page=3",
  ];
  for (const path of paths)
    for (const width of [1440, 1024, 390]) {
      await goto(path, width);
      const problems = (await measureV2Layout(page, { root: "main.k2-ui" })).problems;
      expect({ path, width, problems }).toEqual({ path, width, problems: [] });
      expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  expect(errors).toEqual([]);
}, 240_000);

test("a Skill opens beside the list by its address and closes back to the list; on the phone it is the page", async () => {
  await goto("sec=skills");
  await main().getByRole("link", { name: "cloud-contacts" }).click();
  await page.waitForURL(/skill=sk0004/);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
  expect(await main().getByText("Die App liefert eine neuere Fassung.", { exact: false }).isVisible()).toBe(true);
  expect(await main().getByText("sk0004", { exact: true }).isVisible()).toBe(true);
  await main().getByRole("link", { name: "Schließen", exact: true }).click();
  await page.waitForURL((url) => !url.search.includes("skill="));

  await goto("sec=skills&skill=sk0001", 390);
  const back = main().getByRole("link", { name: "Skills", exact: true }).filter({ visible: true });
  expect(await back.getAttribute("href")).toBe("/admin/ai?sec=skills");
  expect(errors).toEqual([]);
});

test("deleting a Skill asks first; agreeing deletes it and returns to the list", async () => {
  await goto("sec=skills&skill=sk0006");
  await main().getByRole("button", { name: "Aktionen für Angebot entwerfen" }).click();
  await page.getByRole("menuitem", { name: "Skill löschen" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Abbrechen", exact: true }).click();
  expect(sent("DELETE", "/api/admin/core/ai-skills/sk0006")).toHaveLength(0);
  await main().getByRole("button", { name: "Aktionen für Angebot entwerfen" }).click();
  await page.getByRole("menuitem", { name: "Skill löschen" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Löschen", exact: true }).click();
  await page.waitForURL((url) => !url.search.includes("skill="));
  expect(sent("DELETE", "/api/admin/core/ai-skills/sk0006")).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a refused delete keeps the Skill open and says why", async () => {
  await goto("sec=skills&skill=sk0006&state=failwrite");
  await main().getByRole("button", { name: "Aktionen für Angebot entwerfen" }).click();
  await page.getByRole("menuitem", { name: "Skill löschen" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Löschen", exact: true }).click();
  await page.getByText("Synthetic fixture: the change was refused.", { exact: true }).waitFor();
  expect(new URL(page.url()).searchParams.get("skill")).toBe("sk0006");
  expect(errors).toEqual([]);
});

test("an app Skill compares with its app version and goes back to it after one question", async () => {
  await goto("sec=skills&skill=sk0004");
  await main().getByRole("button", { name: "Mit App-Version vergleichen" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("references/felder.md", { exact: true }).waitFor();
  expect(await dialog.getByText("SKILL.md", { exact: true }).isVisible()).toBe(true);
  await dialog.getByRole("button", { name: "Auf App-Version zurücksetzen" }).click();
  const reset = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/ai-skills/sk0004/reset"));
  await page.getByRole("alertdialog").getByRole("button", { name: "Auf App-Version zurücksetzen", exact: true }).click();
  await reset;
  expect(sent("POST", "/api/admin/core/ai-skills/sk0004/reset")[0]?.body).toEqual({
    expectedRevision: 2,
    expectedAppVersion: "d".repeat(64),
    confirmed: true,
  });
  expect(errors).toEqual([]);
});

test("a deleted app Skill comes back, and one whose name is taken links the existing Skill", async () => {
  await goto("sec=skills");
  await main().getByRole("button", { name: "Aktionen für App-Skill cloud-spaces" }).click();
  await page.getByRole("menuitem", { name: "Wiederherstellen" }).click();
  const restore = page.waitForRequest((request) => request.url().endsWith("/apps/spaces/skills/cloud-spaces/restore"));
  await page.getByRole("alertdialog").getByRole("button", { name: "Wiederherstellen", exact: true }).click();
  await restore;
  await page.waitForLoadState("load");
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
  await main().getByRole("button", { name: "Aktionen für App-Skill cloud-contacts-import" }).click();
  await page.getByRole("menuitem", { name: "Vorhandenen Skill verwenden" }).click();
  const adopt = page.waitForRequest((request) => request.url().endsWith("/apps/contacts/skills/cloud-contacts-import/adopt"));
  await page.getByRole("alertdialog").getByRole("button", { name: "Vorhandenen Skill verwenden", exact: true }).click();
  await adopt;
  expect(errors).toEqual([]);
});

test("the search sends its words in the address and Escape shows all Skills again", async () => {
  await goto("sec=skills");
  const search = main().getByRole("searchbox", { name: "KI-Skills durchsuchen" });
  await search.fill("Protokoll");
  await search.press("Enter");
  await page.waitForURL(/search=Protokoll/);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
  expect(await main().getByText("1 Treffer für „Protokoll“", { exact: true }).isVisible()).toBe(true);
  await main().getByRole("searchbox", { name: "KI-Skills durchsuchen" }).press("Escape");
  await page.waitForURL((url) => !url.search.includes("search="));
  expect(errors).toEqual([]);
});

test("a Project opens beside the list and is deleted after one question", async () => {
  await goto("sec=projects");
  await main().getByRole("link", { name: "Altes Intranet" }).click();
  await page.waitForURL(/project=pj0004/);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
  expect(await main().getByText("Niemand kann ändern, wer in diesem Projekt arbeitet.", { exact: false }).isVisible()).toBe(true);
  await main().getByRole("button", { name: "Aktionen für Altes Intranet" }).click();
  await page.getByRole("menuitem", { name: "Projekt löschen" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Löschen", exact: true }).click();
  await page.waitForURL((url) => !url.search.includes("project="));
  expect(sent("DELETE", "/api/admin/core/ai-projects/pj0004")).toHaveLength(1);
  expect(errors).toEqual([]);
});
