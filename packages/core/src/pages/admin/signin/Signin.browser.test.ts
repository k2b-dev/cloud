import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../ui/test/browser";
import { baseAreaBrowserFixture } from "../base/BaseArea.browser-fixture";

// The Sign-in & security area on v2: a registry section saves like every other, and Linux identities save their setup
// only with a reserved range, then backfill the selected accounts one by one after one question.
let browser: Browser;
let fixture: Awaited<ReturnType<typeof baseAreaBrowserFixture>>;
let page: Page;
let errors: string[];

const goto = async (path: string, width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}${path}${path.includes("?") ? "&" : "?"}locale=en`);
  await page.waitForSelector('body[data-ready="true"]');
};
const button = (name: string | RegExp) => page.getByRole("button", { name, exact: typeof name === "string" }).filter({ visible: true });

beforeAll(async () => {
  fixture = await baseAreaBrowserFixture();
  browser = await launchBrowser();
}, 120_000);
beforeEach(async () => {
  if (page) await page.close();
  fixture.reset();
  page = await browser.newPage();
  page.setDefaultTimeout(8000);
  errors = pageErrors(page);
});
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

test("the sign-in and Linux sections keep the v2 rules at every width, with no loader in the first picture", async () => {
  for (const path of ["/admin/signin", "/admin/signin/freeipa", "/admin/signin/linux"])
    for (const width of [1440, 1024, 390]) {
      await goto(path, width);
      expect({ path, width, problems: (await measureV2Layout(page, { root: "main.k2-ui" })).problems }).toEqual({
        path,
        width,
        problems: [],
      });
      expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  expect(errors).toEqual([]);
}, 90_000);

test("a changed Linux setup saves only with the range confirmed as reserved", async () => {
  await goto("/admin/signin/linux");
  await page.getByRole("textbox", { name: /^Login shell/ }).fill("/bin/zsh");
  const save = button("Check and save setup");
  expect(await save.isDisabled()).toBe(true);
  // a changed setup stops selecting until it is saved or discarded
  expect(await page.getByRole("checkbox", { name: "Select eligible accounts on this page" }).count()).toBe(0);
  await page.getByRole("checkbox", { name: "I have reserved this range for Cloud" }).check();
  await save.click();
  await page.getByText("Configuration saved. No accounts were changed.").waitFor();
  expect(fixture.linuxRequests).toContain("PUT reserved=true");
  expect(errors).toEqual([]);
}, 30_000);

test("selected accounts are backfilled after one question, one by one, and can stop after the current one", async () => {
  await goto("/admin/signin/linux");
  await page.getByRole("checkbox", { name: "Select eligible accounts on this page" }).check();
  await button("Backfill 2 selected accounts").click();
  const question = page.getByRole("alertdialog");
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(fixture.linuxRequests.filter((request) => request.startsWith("POST"))).toEqual([]);

  const release = fixture.holdLinux();
  await button("Backfill 2 selected accounts").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Backfill 2 selected accounts", exact: true }).click();
  await button("Stop after current account").click();
  release();
  await page.getByText("Stopped. Completed identities are kept.", { exact: false }).waitFor();
  expect(fixture.linuxRequests.filter((request) => request.startsWith("POST"))).toHaveLength(1);
  // the list is read again: the backfilled account shows its identity
  await page.getByRole("cell", { name: "200001 / 200001" }).waitFor();
  expect(errors).toEqual([]);
}, 30_000);

test("the filter bar keeps the list in the address and loads it in place", async () => {
  await goto("/admin/signin/linux");
  await page
    .getByRole("button", { name: /Show accounts/ })
    .first()
    .click();
  await page.getByRole("option", { name: "Show all accounts" }).click();
  await page.waitForFunction(() => location.search.includes("scope=all"));
  await page.waitForFunction(() => document.querySelectorAll("main tbody tr").length > 0);
  expect(fixture.linuxRequests.some((request) => request.startsWith("GET") && request.includes("scope=all"))).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);
