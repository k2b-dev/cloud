import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { baseAreaBrowserFixture } from "./BaseArea.browser-fixture";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof baseAreaBrowserFixture>>;
let page: Page;
let errors: string[];

const goto = async (path: string, width = 1440) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${fixture.url}${path}${path.includes("?") ? "&" : "?"}locale=en`);
  await page.waitForSelector('body[data-ready="true"]');
};
const visible = (name: string) => page.getByRole("button", { name, exact: true }).filter({ visible: true });
const state = () => page.locator(".k2b-save-status__state").filter({ visible: true }).first().getAttribute("data-state");
const nameField = () => page.getByRole("textbox", { name: "Name", exact: true });

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

test("general settings save with the button in the level head and continue from the stored versions", async () => {
  await goto("/admin/base");
  expect(await page.getByRole("navigation", { name: "Base settings sections" }).getByRole("link").allInnerTexts()).toEqual([
    "General",
    "Legal",
    "PDF rendering",
    "Places & maps",
    "CLI",
  ]);
  expect(await state()).toBe("saved");
  await nameField().fill("Neue Cloud");
  expect(await state()).toBe("draft");
  const request = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await visible("Save").click();
  const body = (await request).postDataJSON();
  expect(body).toEqual({
    updates: { "app.name": "Neue Cloud" },
    resets: [],
    replaceUnreadable: [],
    expectedUpdatedAt: { "app.name": "2026-10-27T08:00:00.000Z" },
  });
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="saved"]')?.textContent?.match(/\d/));
  // A second save sends the version the server stored after the first one.
  await nameField().fill("Neue Cloud 2");
  const second = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await visible("Save").click();
  expect((await second).postDataJSON().expectedUpdatedAt).toEqual({ "app.name": "2026-10-28T10:00:00.000Z" });
  expect(errors).toEqual([]);
}, 30_000);

test("a value someone else changed is shown at its field with both ways out", async () => {
  await goto("/admin/base?state=conflict");
  await nameField().fill("Meine Cloud");
  await visible("Save").click();
  await page.getByText("Mara Beispiel changed this at", { exact: false }).waitFor();
  expect(await state()).toBe("failed");
  expect(await page.getByText('Now "Andere Cloud" applies.', { exact: false }).isVisible()).toBe(true);
  await visible("Save my value").click();
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="saved"]'));
  expect(fixture.saves()).toBe(2);
  expect(errors).toEqual([]);
}, 30_000);

test("an unreadable value is replaced only after the person confirms it", async () => {
  await goto("/admin/base?state=unreadable");
  expect(await page.getByText("The stored value cannot be read.").isVisible()).toBe(true);
  expect(await page.getByRole("textbox", { name: "Time zone" }).isDisabled()).toBe(true);
  expect(await visible("Save").isDisabled()).toBe(true);
  await page.getByRole("checkbox", { name: "Replace stored value: Time zone" }).check();
  expect(await state()).toBe("draft");
  const request = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await visible("Save").click();
  const body = (await request).postDataJSON();
  expect(body.replaceUnreadable).toEqual(["app.timezone"]);
  expect(body.updates).toEqual({ "app.timezone": "Europe/Berlin" });
  expect(errors).toEqual([]);
}, 30_000);

test("a refused save keeps the draft and names the field; secrets stay empty until replaced", async () => {
  await goto("/admin/base?state=savefail");
  await nameField().fill("Andere");
  await visible("Save").click();
  await page.getByText("The name could not be saved.").waitFor();
  expect(await nameField().inputValue()).toBe("Andere");
  expect(await state()).toBe("invalid");

  await goto("/admin/base/pdf");
  expect(await page.getByLabel("Password", { exact: true }).first().inputValue()).toBe("");
  expect(await visible("Test renderer").isDisabled()).toBe(false);
  await page.getByRole("textbox", { name: "Gotenberg address" }).fill("http://pdf:3000");
  expect(await visible("Test renderer").isDisabled()).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

test("a phone shows one level and the save status at the bottom", async () => {
  await goto("/admin/base", 390);
  await nameField().fill("Telefon");
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="draft"]'));
  await settled(page);
  expect(await visible("Save").isVisible()).toBe(true);
  const box = await visible("Save").boundingBox();
  expect(box && box.y > 400).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);
