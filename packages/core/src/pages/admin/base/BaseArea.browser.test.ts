import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { baseAreaBrowserFixture } from "./BaseArea.browser-fixture";

// The Base settings area on v2: a registry form saves with "Save" in its footer through Core's settings API, reports
// a change by someone else with both ways out, resets a value of its own only on save, replaces an unreadable value
// only after the person confirms it, and keeps secrets write-only.
let browser: Browser;
let fixture: Awaited<ReturnType<typeof baseAreaBrowserFixture>>;
let page: Page;
let errors: string[];

const goto = async (path: string, width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}${path}${path.includes("?") ? "&" : "?"}locale=en`);
  await page.waitForSelector('body[data-ready="true"]');
};
const button = (name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const nameField = () => page.getByRole("textbox", { name: /^Name( |$)/ });
const footer = () => page.locator('main [data-k2-part="Bar"]').filter({ has: page.getByRole("button", { name: "Save", exact: true }) });

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

test("the sections stand under their entry in the admin bar, and the page keeps the v2 rules at every width", async () => {
  for (const width of [1440, 1024, 390]) {
    await goto("/admin/base?state=legacy", width);
    if (width === 1440) {
      const nav = page.getByRole("navigation", { name: "Administration" });
      expect(await nav.locator('[data-level="2"]').allInnerTexts()).toEqual(["Allgemein", "PDF-Erstellung", "CLI"]);
      expect(await nav.locator('[aria-current="page"]').innerText()).toBe("Allgemein");
    }
    expect((await measureV2Layout(page, { root: "main.k2-ui" })).problems).toEqual([]);
    expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
}, 60_000);

test("general settings save with the footer's Save and continue from the stored versions", async () => {
  await goto("/admin/base");
  expect(await button("Save").isDisabled()).toBe(true);
  await nameField().fill("Neue Cloud");
  expect(await footer().innerText()).toContain("Unsaved changes");
  const request = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await button("Save").click();
  expect((await request).postDataJSON()).toEqual({
    updates: { "app.name": "Neue Cloud" },
    resets: [],
    replaceUnreadable: [],
    expectedUpdatedAt: { "app.name": "2026-10-27T08:00:00.000Z" },
  });
  await footer()
    .getByText(/^Saved at \d/)
    .waitFor();
  // A second save sends the version the server stored after the first one.
  await nameField().fill("Neue Cloud 2");
  const second = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await button("Save").click();
  expect((await second).postDataJSON().expectedUpdatedAt).toEqual({ "app.name": "2026-10-28T10:00:00.000Z" });
  expect(errors).toEqual([]);
}, 30_000);

test("a value someone else changed is a notice with both ways out", async () => {
  await goto("/admin/base?state=conflict");
  await nameField().fill("Meine Cloud");
  await button("Save").click();
  const notice = page.locator('[data-k2-part="Notice"]', { hasText: "Mara Beispiel changed this at" });
  await notice.waitFor();
  expect(await notice.innerText()).toContain('Name: now "Andere Cloud" applies.');
  await notice.getByRole("button", { name: "Save my value", exact: true }).click();
  await footer()
    .getByText(/^Saved at /)
    .waitFor();
  expect(fixture.saves()).toBe(2);
  expect(errors).toEqual([]);
}, 30_000);

test("a reset goes back to the default only on save, Discard drops it, and a removed value is saved against no row", async () => {
  await goto("/admin/base");
  // The third field's place below the first, independent of where the pane is scrolled.
  const thirdTop = () =>
    page.evaluate(() => {
      const fields = document.querySelectorAll('main [data-k2-part="Field"]');
      return Math.round(fields[2]!.getBoundingClientRect().top - fields[0]!.getBoundingClientRect().top);
    });
  await settled(page);
  const before = await thirdTop();
  await footer().getByRole("button", { name: "Reset to default" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Name" }).click();
  expect(await nameField().isDisabled()).toBe(true);
  expect(await page.getByText("Goes back to the default when you save.").isVisible()).toBe(true);
  // A staged reset keeps every field where it was.
  await settled(page);
  expect(await thirdTop()).toBe(before);
  // A ticked entry keeps the menu open for more; Escape closes it.
  await page.keyboard.press("Escape");
  await button("Discard").click();
  expect(await nameField().isDisabled()).toBe(false);
  expect(await button("Save").isDisabled()).toBe(true);

  await goto("/admin/base?state=conflictgone");
  await nameField().fill("Meine Cloud");
  await button("Save").click();
  await button("Save my value").waitFor();
  const retry = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await button("Save my value").click();
  expect((await retry).postDataJSON().expectedUpdatedAt).toEqual({ "app.name": null });
  expect(errors).toEqual([]);
}, 30_000);

test("an unreadable value is replaced only after the person confirms it", async () => {
  await goto("/admin/base?state=unreadable");
  const notice = page.locator('[data-k2-part="Notice"]', { hasText: "Time zone: The stored value cannot be read." });
  expect(await notice.isVisible()).toBe(true);
  expect(await page.getByRole("textbox", { name: /^Time zone/ }).isDisabled()).toBe(true);
  expect(await button("Save").isDisabled()).toBe(true);
  await page.getByRole("checkbox", { name: "Replace stored value: Time zone" }).check();
  expect(await page.getByRole("textbox", { name: /^Time zone/ }).isDisabled()).toBe(false);
  const request = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await button("Save").click();
  const body = (await request).postDataJSON();
  expect(body.replaceUnreadable).toEqual(["app.timezone"]);
  expect(body.updates).toEqual({ "app.timezone": "Europe/Berlin" });
  expect(errors).toEqual([]);
}, 30_000);

test("a refused save keeps the draft and names the field; secrets stay empty until replaced", async () => {
  await goto("/admin/base?state=savefail");
  await nameField().fill("Andere");
  await button("Save").click();
  await page.getByText("The name could not be saved.").waitFor();
  expect(await nameField().inputValue()).toBe("Andere");
  expect(await nameField().getAttribute("aria-invalid")).toBe("true");
  expect(await page.locator('[data-k2-part="Notice"]', { hasText: "Not saved." }).isVisible()).toBe(true);
  // The refused save can be tried again without changing anything.
  expect(await button("Save").isDisabled()).toBe(false);

  await goto("/admin/base/pdf");
  const password = page.getByLabel(/^Password/);
  expect(await password.inputValue()).toBe("");
  expect(await password.getAttribute("type")).toBe("password");
  expect(await button("Test renderer").isDisabled()).toBe(false);
  await page.getByRole("textbox", { name: /^Gotenberg address/ }).fill("http://pdf:3000");
  expect(await button("Test renderer").isDisabled()).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test("the PDF test reports in a toast and a failure in place; the legacy settings go after one question, and the cache clears", async () => {
  await goto("/admin/base/pdf");
  await button("Test renderer").click();
  await page.getByText("PDF rendered (", { exact: false }).waitFor();
  // a failed test names the reason above the form, where it stays until the next test
  await goto("/admin/base/pdf?state=testfail");
  await button("Test renderer").click();
  const failed = page.locator('main [data-k2-part="Notice"][data-tone="bad"]');
  await failed.waitFor();
  expect(await failed.innerText()).toContain("Test failed");
  expect(await failed.innerText()).toContain("Gotenberg did not answer within 10 s");

  await goto("/admin/base?state=legacy");
  expect(await page.getByRole("table", { name: "Legacy settings" }).getByText("mail.old_relay_host").isVisible()).toBe(true);
  await button("Clean up").click();
  const question = page.getByRole("alertdialog");
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(fixture.legacyDeletes()).toBe(0);
  await button("Clean up").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clean up", exact: true }).click();
  await page.getByText("2 legacy settings deleted.").waitFor();
  expect(fixture.legacyDeletes()).toBe(1);
  expect(await page.getByText("No legacy settings found.").isVisible()).toBe(true);

  await button("Clear cache").click();
  await page.getByText("Cache cleared", { exact: true }).waitFor();
  expect(errors).toEqual([]);
}, 30_000);
