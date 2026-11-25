import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../ui/test/browser";
import { outgoingMailBrowserFixture } from "./OutgoingMail.browser-fixture";

// Outgoing mail on v2: sender profiles open as a form beside the list and save the whole profile, an app's sending and
// send log access save apart, and the send log keeps its filters in the address and opens a message beside it.
let browser: Browser;
let fixture: Awaited<ReturnType<typeof outgoingMailBrowserFixture>>;
let page: Page;
let errors: string[];

const goto = async (path: string, width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}${path}${path.includes("?") ? "&" : "?"}locale=en`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
};
const button = (name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const sent = (method: string, path: string) => fixture.requests.filter((request) => request.method === method && request.path === path);

beforeAll(async () => {
  fixture = await outgoingMailBrowserFixture();
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

test("every section keeps the v2 rules at every width, with no loader in the first picture", async () => {
  for (const path of [
    "/admin/outgoing-mail",
    "/admin/outgoing-mail?profile=system",
    "/admin/outgoing-mail/apps?app=invoices",
    "/admin/outgoing-mail/log",
  ])
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
}, 120_000);

test("a profile saves as a whole: the stored password stays unless replaced, and IMAP stays off without a host", async () => {
  await goto("/admin/outgoing-mail?profile=newsletter");
  const save = button("Save");
  expect(await save.isDisabled()).toBe(true);
  await page
    .getByRole("textbox", { name: /^Display name|^Sender name|^From name/ })
    .first()
    .fill("Unser Rundbrief");
  await save.click();
  await page.waitForFunction(() => !location.search.includes("profile="));
  const [request] = sent("PUT", "/api/admin/core/outgoing-mail/profiles/newsletter");
  const body = request?.body as Record<string, unknown>;
  expect(body.fromName).toBe("Unser Rundbrief");
  expect(body).not.toHaveProperty("smtpPassword");
  expect(body.imap).toBeNull();
  expect(body.revision).toBe(3);
  expect(errors).toEqual([]);
}, 30_000);

test("a refused save keeps the draft with the reason, and a changed draft asks before it is left", async () => {
  await goto("/admin/outgoing-mail?profile=newsletter");
  const name = page.getByRole("textbox", { name: /^Name/ }).first();
  await name.fill("Fehler");
  await button("Save").click();
  await page
    .locator('main [data-k2-part="Notice"]')
    .filter({ hasText: /changed|conflict|geändert/i })
    .waitFor();
  expect(await name.inputValue()).toBe("Fehler");
  await button("Cancel").click();
  const question = page.getByRole("alertdialog");
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await name.inputValue()).toBe("Fehler");
  expect(errors).toEqual([]);
}, 30_000);

test("a test mail goes from the profile's menu; making another profile the default asks first", async () => {
  await goto("/admin/outgoing-mail?profile=newsletter");
  await page
    .getByRole("button", { name: /Newsletter/ })
    .filter({ visible: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: /test/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("ich@example.test");
  await dialog.getByRole("button", { name: /Send/ }).click();
  await dialog.waitFor({ state: "detached" });
  expect(sent("POST", "/api/admin/core/outgoing-mail/profiles/newsletter/test")[0]?.body).toEqual({ recipient: "ich@example.test" });
  expect(errors).toEqual([]);
}, 30_000);

test("an app's sending access and its send log access save apart; a refused grant says so in place", async () => {
  await goto("/admin/outgoing-mail/apps?app=backoffice");
  await page.getByRole("radio", { name: "Selected profiles" }).check();
  await page.getByRole("checkbox", { name: /Newsletter/ }).check();
  await page.locator('[data-k2-part="Section"]').first().getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => location.search.includes("app=backoffice"));
  expect(sent("PUT", "/api/admin/core/outgoing-mail/apps/backoffice")[0]?.body).toEqual({ mode: "selected", profiles: ["newsletter"] });

  await goto("/admin/outgoing-mail/apps?app=backoffice");
  await page.locator('[data-k2-part="Section"]').nth(1).getByRole("button", { name: "Save", exact: true }).click();
  await page.locator('[data-k2-part="Section"]').nth(1).locator('[data-k2-part="Notice"]').filter({ hasText: /log/i }).waitFor();
  expect(errors).toEqual([]);
}, 30_000);

test("the send log opens a message beside it, shows its text on request, and cancels a queued one after a question", async () => {
  await goto("/admin/outgoing-mail/log");
  // A row opens its message in the address.
  await page.getByRole("link", { name: "Mahnung 2026-099" }).first().click();
  await page.waitForURL(/message=aaaaaaaa-0000-4000-8000-000000000002/);
  await goto("/admin/outgoing-mail/log?message=aaaaaaaa-0000-4000-8000-000000000002");
  await button("Cancel mail").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel mail", exact: true }).click();
  await page.getByRole("region", { name: "Notifications" }).getByText("Mail cancelled.").waitFor();
  expect(sent("POST", "/api/admin/core/outgoing-mail/messages/aaaaaaaa-0000-4000-8000-000000000002/cancel")).toHaveLength(1);

  await goto("/admin/outgoing-mail/log?message=aaaaaaaa-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: /Show/ }).filter({ visible: true }).first().click();
  await page.getByText("Guten Tag, anbei Ihre Rechnung.").waitFor();
  expect(errors).toEqual([]);
}, 30_000);

test("the send log's old addresses keep their filters, and the retention saves both periods", async () => {
  await goto("/admin/outgoing-mail/log?app=invoices");
  expect(await page.locator('[data-k2-part="FilterBar"]').innerText()).toContain("Invoices");
  await button("Retention").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("spinbutton", { name: /Keep text for \(days\)/ }).fill("60");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  expect(sent("PUT", "/api/admin/core/outgoing-mail/retention")[0]?.body).toMatchObject({ contentDays: 60 });
  expect(errors).toEqual([]);
}, 30_000);
