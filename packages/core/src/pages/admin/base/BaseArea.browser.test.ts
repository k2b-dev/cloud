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

test("Discard also drops a staged default, and a removed value is saved against no stored row", async () => {
  await goto("/admin/base");
  const thirdRowTop = async () => {
    await settled(page);
    return page.evaluate(() =>
      Math.round(document.querySelectorAll('[data-workspace-heading="page"] .k2b-settings-field')[2]!.getBoundingClientRect().top),
    );
  };
  const before = await thirdRowTop();
  // A text row and an image row: a staged reset keeps every row where it was.
  for (const name of ["Name", "app.logo"]) await page.getByRole("button", { name: `Reset ${name} to the default` }).click();
  expect(await state()).toBe("draft");
  expect(await thirdRowTop()).toBe(before);
  // "Undo" takes the place of "Reset", so the way back is where the person just clicked.
  expect(await page.getByRole("button", { name: "Undo reset of Name" }).isVisible()).toBe(true);
  await visible("Discard").click();
  expect(await state()).toBe("saved");
  expect(await visible("Save").isDisabled()).toBe(true);

  await goto("/admin/base?state=conflictgone");
  await nameField().fill("Meine Cloud");
  await visible("Save").click();
  await visible("Save my value").waitFor();
  const retry = page.waitForRequest((candidate) => candidate.method() === "PUT");
  await visible("Save my value").click();
  expect((await retry).postDataJSON().expectedUpdatedAt).toEqual({ "app.name": null });
  await page.waitForFunction(() => document.querySelector('.k2b-save-status__state[data-state="saved"]'));
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
  // The refused save can be tried again without changing anything.
  expect(await state()).toBe("failed");
  expect(await visible("Save").isDisabled()).toBe(false);

  await goto("/admin/base/pdf");
  expect(await page.getByLabel("Password", { exact: true }).first().inputValue()).toBe("");
  expect(await visible("Test renderer").isDisabled()).toBe(false);
  await page.getByRole("textbox", { name: "Gotenberg address" }).fill("http://pdf:3000");
  expect(await visible("Test renderer").isDisabled()).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

/** Left edges and font sizes of the page title, the group titles, and every row's name, field and source. */
const anatomy = async () => {
  await settled(page);
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('[data-workspace-heading="page"]')!;
    const left = (element: Element | null) => Math.round(element!.getBoundingClientRect().left);
    const size = (element: Element | null) => Number.parseFloat(getComputedStyle(element!).fontSize);
    const all = (selector: string) => Array.from(pane.querySelectorAll(selector));
    const title = pane.querySelector(".k2b-app-workspace__level-title > h2 > .k2b-truncate-fade");
    const head = pane.querySelector(".k2b-app-workspace__level-head")!;
    return {
      title: { left: left(title), size: size(title) },
      // Where the head's content starts; on a phone the step back sits there and the title follows it.
      headEdge: Math.round(head.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(head).paddingLeft)),
      sections: all(".k2b-settings-section").map(left),
      groupTitles: all(".k2b-settings-section__header").map(left),
      groupSize: size(pane.querySelector(".k2b-settings-section__heading h2")),
      names: [...new Set(all(".k2b-settings-field__copy").map(left))],
      nameSize: size(pane.querySelector(".k2b-settings-field__heading strong")),
      helpSize: size(pane.querySelector(".k2b-settings-field__copy > p")),
      fields: [...new Set(all(".k2b-settings-field:not([data-width=full]) .k2b-settings-field__control").map(left))],
      sources: [...new Set(all(".k2b-settings-field__source").map(left))],
      // What each row's source shows: a button's word, or the quiet text.
      source: Object.fromEntries(
        all(".k2b-settings-field").map((row) => [
          row.querySelector(".k2b-settings-field__heading strong")!.textContent,
          row.querySelector(".k2b-settings-field__source button")
            ? `button:${row.querySelector(".k2b-settings-field__source button")!.textContent!.trim()}`
            : row.querySelector(".k2b-settings-field__source")!.textContent,
        ]),
      ),
      firstRow: Math.round(pane.querySelector(".k2b-settings-field")!.getBoundingClientRect().top),
    };
  });
};

test("every value has a fixed place: one edge for title and content, page over group over field", async () => {
  await goto("/admin/base");
  const desktop = await anatomy();
  // The page title and the content share one edge; the content adds no inset of its own.
  expect(desktop.headEdge).toBe(desktop.title.left);
  expect(new Set(desktop.sections)).toEqual(new Set([desktop.title.left]));
  expect(desktop.title.size).toBe(18);
  expect(desktop.groupSize).toBe(14);
  expect(desktop.nameSize).toBe(13);
  expect(desktop.helpSize).toBe(12);
  // Wide enough for the group column: every name, every field and every source starts at one x.
  expect(desktop.groupTitles.every((x) => x === desktop.title.left)).toBe(true);
  expect(desktop.names).toHaveLength(1);
  expect(desktop.names[0]!).toBeGreaterThan(desktop.title.left);
  expect(desktop.fields).toHaveLength(1);
  expect(desktop.sources).toHaveLength(1);
  // Reset shows only beside a value of its own; a default stays quiet text.
  expect(desktop.source.Name).toBe("button:Reset");
  expect(desktop.source["Cleanup schedule"]).toBe("Default");

  // A draft changes the status in the head, never the place of a row.
  await nameField().fill("Neue Cloud");
  expect(await state()).toBe("draft");
  expect((await anatomy()).firstRow).toBe(desktop.firstRow);

  await goto("/admin/base", 390);
  const phone = await anatomy();
  expect(new Set(phone.sections)).toEqual(new Set([phone.headEdge]));
  expect(phone.names).toEqual([phone.headEdge]);
  expect(phone.fields).toEqual([phone.headEdge]);
  expect(phone.groupTitles.every((x) => x === phone.headEdge)).toBe(true);
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

test("Sign-in shows the options of an account type only while it is on; FreeIPA tests the saved connection", async () => {
  await goto("/admin/signin");
  expect(await page.getByRole("navigation", { name: "Sign-in & security sections" }).getByRole("link").allInnerTexts()).toEqual([
    "Sign-in",
    "Registration",
    "Security",
    "Linux identities",
    "FreeIPA",
    "Account operations",
  ]);
  expect(await page.getByText("Show guest sign-in").count()).toBe(0);
  await page.getByRole("switch", { name: "Guest accounts" }).click();
  await page.getByText("Show guest sign-in").waitFor();
  expect(await state()).toBe("draft");

  await goto("/admin/signin/freeipa");
  expect(await visible("Test connection").isDisabled()).toBe(false);
  await page.getByRole("textbox", { name: "FreeIPA address" }).fill("https://ipa2.example.org");
  expect(await visible("Test connection").isDisabled()).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);
