import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../ui/test/browser";
import { aiAreaBrowserFixture } from "./AiArea.browser-fixture";

// AI › General, Background jobs and Tools & API on v2: registry settings as Setting rows that save with the footer's
// Save, the built-in texts open read-only, the enrichment runs by hand, and every section keeps the v2 rules.
setDefaultTimeout(20_000);
let browser: Browser;
let fixture: Awaited<ReturnType<typeof aiAreaBrowserFixture>>;
let page: Page;
let errors: string[];

const goto = async (query: string, width = 1440, locale = "en") => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}?locale=${locale}&${query}`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
};
const button = (name: string) => page.locator("main").getByRole("button", { name, exact: true }).filter({ visible: true });
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

test("each section keeps the v2 rules at every width, worst case included, with no loader in the first picture", async () => {
  const paths = ["sec=general", "sec=jobs", "sec=tools", "sec=general&state=worst", "sec=jobs&state=worst", "sec=jobs&state=empty"];
  for (const path of paths)
    for (const width of [1440, 1024, 390]) {
      await goto(path, width, "de");
      // The v1 template editor stands in for a missing v2 one (k2b-ui gap) and is not measured.
      const problems = (await measureV2Layout(page, { root: "main.k2-ui", skip: ".k2b-field, .k2b-template-editor" })).problems;
      expect({ path, width, problems }).toEqual({ path, width, problems: [] });
      expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  expect(errors).toEqual([]);
}, 180_000);

test("the sections stand under KI in the admin bar and lead with the state that matters", async () => {
  await goto("sec=general", 1440, "de");
  const nav = page.getByRole("navigation", { name: "Administration" });
  expect(await nav.locator('[aria-current="page"]').innerText()).toBe("Allgemein");
  expect(await page.locator('main [data-k2-part="StatusRow"]').innerText()).toContain("KI ist an");
  // the AI area's own words, in German, for fields the registry words in English
  expect(await page.locator('main [data-k2-part="Setting"]').getByText("KI in dieser Cloud", { exact: true }).count()).toBe(1);
  expect(await page.locator('main [data-k2-part="Setting"]').getByText("Globale Anweisungen", { exact: true }).count()).toBe(1);

  await goto("sec=jobs", 1440, "de");
  expect(await page.locator('main [data-k2-part="StatusRow"]').innerText()).toContain("12 Chats warten auf Anreicherung");
  await goto("sec=tools", 1440, "de");
  const tools = await page.locator('main [data-k2-part="StatusRow"]').innerText();
  expect(tools).toContain("OpenAI-kompatible API ist an");
  expect(tools).toContain("Websuche eingerichtet");
  await goto("sec=general&state=empty", 1440, "de");
  expect(await page.locator('main [data-k2-part="StatusRow"]').innerText()).toContain("KI ist aus");
  expect(errors).toEqual([]);
});

test("a change saves with the footer's Save and the observed version, then the page reloads with the server's words", async () => {
  await goto("sec=jobs");
  expect(await button("Save").isDisabled()).toBe(true);
  const field = page.getByRole("textbox", { name: /^Additional chat enrichment instructions/ });
  await field.fill("Nutze die Projektnamen.");
  expect(await page.locator("main").getByText("1 change", { exact: true }).isVisible()).toBe(true);
  const reload = page.waitForEvent("load");
  await button("Save").click();
  await reload;
  expect(sent("PUT", "/api/admin/core/settings")[0]?.body).toEqual({
    updates: { "ai.chat_enrichment_instructions": "Nutze die Projektnamen." },
    resets: [],
    replaceUnreadable: [],
    expectedUpdatedAt: { "ai.chat_enrichment_instructions": "2026-11-25T11:40:00.000Z" },
  });
  expect(errors).toEqual([]);
});

test("a rejected save keeps the instructions, names the field and sends the observed version", async () => {
  await goto("sec=jobs&state=savefail");
  const field = page.getByRole("textbox", { name: /^Additional chat enrichment instructions/ });
  await field.fill("Keep this draft");
  await button("Save").click();
  await page.locator("main").getByText("Instructions could not be saved. Try again.").first().waitFor();
  expect(sent("PUT", "/api/admin/core/settings")[0]?.body).toEqual({
    updates: { "ai.chat_enrichment_instructions": "Keep this draft" },
    resets: [],
    replaceUnreadable: [],
    expectedUpdatedAt: { "ai.chat_enrichment_instructions": "2026-11-25T11:40:00.000Z" },
  });
  expect(await field.inputValue()).toBe("Keep this draft");
  expect(await field.getAttribute("aria-invalid")).toBe("true");
  expect(await page.locator('main [data-k2-part="Notice"]', { hasText: "Not saved." }).isVisible()).toBe(true);
  expect(await button("Save").isDisabled()).toBe(false);
  expect(errors).toEqual([]);
});

test("built-in prompts and texts open read-only and save nothing", async () => {
  await goto("sec=jobs");
  await page
    .locator("main")
    .getByRole("button", { name: /^Personalization/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  expect(await dialog.innerText()).toContain("Original turn learning prompt");
  expect(await dialog.innerText()).toContain("Original workflow prompt");
  expect(await dialog.locator("textarea, input").count()).toBe(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await dialog.waitFor({ state: "hidden" });

  await goto("sec=general");
  await page
    .locator("main")
    .getByRole("button", { name: /^Platform prompt/ })
    .click();
  expect(await page.getByRole("dialog").innerText()).toContain("You are Cloud AI");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  expect(sent("PUT", "/api/admin/core/settings")).toHaveLength(0);
  expect(errors).toEqual([]);
});

test("the enrichment runs by hand and a failure says why; the jobs page is one link away", async () => {
  await goto("sec=jobs");
  expect(await page.locator("main").getByRole("link", { name: "Open jobs" }).getAttribute("href")).toBe(
    "/admin/observability/jobs?search=ai%3Achat",
  );
  const reload = page.waitForEvent("load");
  await button("Run now").click();
  await reload;
  expect(sent("POST", "/api/admin/core/settings/run-ai-enrichment")).toHaveLength(1);

  await goto("sec=jobs&state=runfail");
  await button("Run now").click();
  await page.getByText("The provider did not answer.").waitFor();
  expect(await button("Run now").isDisabled()).toBe(false);
  expect(errors).toEqual([]);
});

test("on the phone a section is the page: the statement, then the settings with Save at their end", async () => {
  await goto("sec=general", 390, "de");
  expect(await page.locator('main [data-k2-part="StatusRow"]').innerText()).toContain("KI ist an");
  expect(await page.locator("main").getByRole("button", { name: "Speichern", exact: true }).isVisible()).toBe(true);
  expect(errors).toEqual([]);
});
