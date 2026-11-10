import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";
import { type MapDialogFixture, startMapDialogFixture } from "../../test/map-dialog-fixture";

setDefaultTimeout(30_000);

let browser: Browser;
let fixture: MapDialogFixture;
beforeAll(async () => {
  fixture = await startMapDialogFixture();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  fixture?.stop();
});

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const open = async (
  options: BrowserContextOptions,
  scene: string,
  mount: { restoreId?: string; loading?: boolean } = {},
  query = "",
): Promise<Page> => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.goto(fixture.url + query);
  await page.waitForFunction(() => "mountScene" in window);
  await page.evaluate(([name, value]) => (window as unknown as { mountScene: (n: string, o: object) => void }).mountScene(name!, value!), [
    scene,
    mount,
  ] as const);
  await page.locator(".k2b-map-tile").waitFor();
  return page;
};
const tile = (page: Page) => page.locator(".k2b-map-tile__open");
const dialog = (page: Page) => page.locator("dialog[open] .k2b-map-dialog");
// The live map has drawn its image; its fade may still run, which these checks do not read.
const mapReady = (page: Page) => page.locator('dialog[open] .k2b-map-view[data-state="ready"]').waitFor();
// The dialog returns focus in the frame after it closed.
const tileFocused = (page: Page) => page.waitForFunction(() => document.activeElement?.classList.contains("k2b-map-tile__open"));
const selectedName = (page: Page) =>
  page.locator('.k2b-map-dialog__place[aria-selected="true"] .k2b-map-dialog__place-text > span').first().textContent();

test("the tile is one named button with the summary pill; it opens the map with the list, details and navigation", async () => {
  const page = await open(desktop, "route");
  try {
    expect(await tile(page).getAttribute("aria-label")).toBe("Karte öffnen: Auslieferung Donnerstag, 86,4 km, 4 Stopps");
    expect(await page.locator(".k2b-map-tile__summary").textContent()).toBe("86,4 km · 1 h 32 min · A → B → C → D");
    // A still map: no zoom controls and no focusable pins inside the tile.
    expect(await page.locator(".k2b-map-tile .k2b-map-view__controls").isHidden()).toBe(true);
    expect(await page.locator(".k2b-map-tile button.k2b-map-view__pin").count()).toBe(0);
    await tile(page).click();
    await dialog(page).waitFor();
    await mapReady(page);
    expect(await page.locator("dialog[open]").getAttribute("aria-labelledby")).toBeTruthy();
    expect(await page.locator("dialog[open] h2").textContent()).toBe("Auslieferung Donnerstag");
    expect(await page.locator(".k2b-map-dialog__facts").textContent()).toContain("86,4 km");
    expect(await page.locator(".k2b-map-dialog__place").count()).toBe(4);
    expect(await selectedName(page)).toBe("Lager Antik Lindner");
    const detail = page.locator(".k2b-map-dialog__detail");
    expect(await detail.locator("h3").textContent()).toBe("Lager Antik Lindner");
    expect(await detail.textContent()).toContain("Warenfluss · Lager");
    expect(await detail.textContent()).toContain("Laden: Biedermeier-Vitrine");
    const nav = detail.getByRole("link", { name: "In OpenStreetMap öffnen" });
    expect(await nav.getAttribute("href")).toBe("https://www.openstreetmap.org/directions?route=%3B49%2C10.952");
    expect(await nav.getAttribute("target")).toBe("_blank");
    expect(await page.locator(".k2b-map-dialog__provenance").textContent()).toContain("Zeiten ohne Verkehr");
  } finally {
    await page.context().close();
  }
});

test("caller links open inside or beside the page; other schemes are dropped", async () => {
  const page = await open(desktop, "route");
  try {
    await tile(page).click();
    await page.locator(".k2b-map-dialog__place").nth(1).click();
    const detail = page.locator(".k2b-map-dialog__detail");
    const contact = detail.getByRole("link", { name: "Kontakt öffnen" });
    expect(await contact.getAttribute("href")).toBe(`${fixture.url}app/contacts/brandl`);
    expect(await contact.getAttribute("target")).toBeNull();
    expect(await detail.getByRole("link", { name: "Bad" }).count()).toBe(0);
    await page.locator(".k2b-map-dialog__place").nth(3).click();
    const order = detail.getByRole("link", { name: "Auftrag öffnen" });
    expect(await order.getAttribute("target")).toBe("_blank");
    expect(await order.getAttribute("rel")).toBe("noopener noreferrer");
  } finally {
    await page.context().close();
  }
});

test("keyboard: Enter opens, arrows move list and pin together, Escape closes back onto the tile", async () => {
  const page = await open(desktop, "route");
  try {
    await page.keyboard.press("Tab");
    await tileFocused(page);
    await page.keyboard.press("Enter");
    await dialog(page).waitFor();
    await mapReady(page);
    await page.locator(".k2b-map-dialog__list").focus();
    await page.keyboard.press("ArrowDown");
    expect(await selectedName(page)).toBe("Familie Brandl");
    expect(await page.locator('.k2b-map-dialog .k2b-map-view__pin[aria-pressed="true"]').getAttribute("data-id")).toBe("b");
    await page.keyboard.press("End");
    expect(await selectedName(page)).toBe("Dr. Helene Voss");
    await page.keyboard.press("Home");
    expect(await selectedName(page)).toBe("Lager Antik Lindner");
    await page.keyboard.press("Escape");
    await page
      .locator("dialog[open]")
      .waitFor({ state: "detached" })
      .catch(() => {});
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await tileFocused(page);
  } finally {
    await page.context().close();
  }
});

test("a pin selects its list row, and choosing another place never moves the list", async () => {
  const page = await open(desktop, "places");
  try {
    await tile(page).click();
    await dialog(page).waitFor();
    await mapReady(page);
    const list = page.locator(".k2b-map-dialog__list");
    // settled: the list's box depends on the dialog layout only, not on the map image fading in.
    const before = await list.boundingBox();
    await page.locator('.k2b-map-dialog .k2b-map-view__pin[data-id="p7"]').click();
    expect(await selectedName(page)).toBe("Schreinerei Kugler");
    expect(await page.locator(".k2b-map-dialog__detail h3").textContent()).toBe("Schreinerei Kugler");
    // A suggestion from an account without a person carries the AI tone.
    expect(await page.locator(".k2b-map-dialog__source-ai").count()).toBe(1);
    expect(await page.locator(".k2b-map-dialog__detail").getByRole("link", { name: "Route hierher" }).count()).toBe(1);
    await page.locator(".k2b-map-dialog__place").first().click();
    // settled: the same layout-only read right after the selection, which must not move the list at any moment.
    expect(await list.boundingBox()).toEqual(before);
  } finally {
    await page.context().close();
  }
});

test("Back closes the map and returns focus to the tile; the URL names the map only while it is open", async () => {
  const page = await open(desktop, "route", { restoreId: "tour-7" });
  try {
    await tile(page).click();
    await dialog(page).waitFor();
    expect(new URL(page.url()).searchParams.get("map")).toBe("tour-7");
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await tileFocused(page);
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("map"));
    // The close button also leaves no entry behind: Back afterwards leaves the page, not into a closed dialog.
    await tile(page).click();
    await dialog(page).waitFor();
    await page.locator(".k2b-map-dialog__close").click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]") && !new URL(location.href).searchParams.has("map"));
    await page.goBack();
    expect(page.url()).toBe("about:blank");
  } finally {
    await page.context().close();
  }
});

test("a reload with the map in the URL opens it again once its places loaded", async () => {
  const page = await open(desktop, "route", { restoreId: "tour-7", loading: true }, "?conversation=c1&map=tour-7");
  try {
    expect(await tile(page).isDisabled()).toBe(true);
    expect(await page.locator(".k2b-map-tile__summary .k2b-spin").count()).toBe(1);
    expect(await page.locator("dialog[open]").count()).toBe(0);
    await page.evaluate(() => (window as unknown as { finishLoading: () => void }).finishLoading());
    await dialog(page).waitFor();
    expect(await page.locator(".k2b-map-dialog__place").count()).toBe(4);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    expect(new URL(page.url()).searchParams.get("conversation")).toBe("c1");
    expect(new URL(page.url()).searchParams.has("map")).toBe(false);
    await tileFocused(page);
  } finally {
    await page.context().close();
  }
});

test("an open map survives a reload in its own history entry; closing leaves no entry behind", async () => {
  const page = await open(desktop, "route", { restoreId: "tour-7" }, "?conversation=c1");
  try {
    await tile(page).click();
    await dialog(page).waitFor();
    expect(new URL(page.url()).searchParams.get("map")).toBe("tour-7");
    await page.reload();
    await page.waitForFunction(() => "mountScene" in window);
    await page.evaluate(() =>
      (window as unknown as { mountScene: (n: string, o: object) => void }).mountScene("route", { restoreId: "tour-7" }),
    );
    await dialog(page).waitFor();
    await page.locator(".k2b-map-dialog__close").click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await tileFocused(page);
    expect(new URL(page.url()).searchParams.get("conversation")).toBe("c1");
    expect(new URL(page.url()).searchParams.has("map")).toBe(false);
    // The resumed entry was the dialog's own: one Back leaves the page.
    await page.goBack();
    expect(page.url()).toBe("about:blank");
  } finally {
    await page.context().close();
  }
});

test("a tile that goes away takes its dialog along; the remounted tile opens one dialog", async () => {
  const page = await open(desktop, "route", { restoreId: "tour-7" });
  try {
    await tile(page).click();
    await dialog(page).waitFor();
    await page.evaluate(() =>
      (window as unknown as { mountScene: (n: string, o: object) => void }).mountScene("route", { restoreId: "tour-7" }),
    );
    await page.waitForFunction(() => document.querySelectorAll("dialog[open] .k2b-map-dialog").length === 1);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    // No second dialog waits behind the closed one.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.locator("dialog[open]").count()).toBe(0);
    expect(new URL(page.url()).searchParams.has("map")).toBe(false);
  } finally {
    await page.context().close();
  }
});

test("loading, empty and single-place states keep their places", async () => {
  const page = await open(desktop, "empty");
  try {
    await tile(page).click();
    await dialog(page).waitFor();
    expect(await page.locator(".k2b-map-dialog__empty").textContent()).toContain("Keine Orte auf dieser Karte.");
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window as unknown as { mountScene: (n: string) => void }).mountScene("single"));
    await tile(page).click();
    await dialog(page).waitFor();
    expect(await page.locator(".k2b-map-dialog[data-single]").count()).toBe(1);
    expect(await page.locator(".k2b-map-dialog__list").count()).toBe(0);
    expect(await page.locator(".k2b-map-dialog__detail").textContent()).toContain("Schlossallee 7, 91790 Sandberg");
    expect(await page.locator(".k2b-map-dialog__count").textContent()).toBe("Privatadresse");
    expect(await page.getByRole("button", { name: "Adresse kopieren" }).count()).toBe(1);
  } finally {
    await page.context().close();
  }
});

test("on a phone the map fills the screen and the list is a sheet with three heights", async () => {
  const page = await open(phone, "route");
  try {
    await tile(page).tap();
    await dialog(page).waitFor();
    await page.waitForFunction(() => document.querySelector("dialog[open]")?.getBoundingClientRect().width === 390);
    const frame = await page.locator("dialog[open]").boundingBox();
    expect(frame).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    expect(await page.locator(".k2b-map-dialog__close-float").isVisible()).toBe(true);
    expect(await page.locator(".k2b-map-dialog__close").isVisible()).toBe(false);
    const side = page.locator(".k2b-map-dialog__side");
    expect(await side.getAttribute("data-sheet-detent")).toBe("half");
    // Details of the selected stop come first in the sheet, with a full-width navigation link.
    const detailTop = (await page.locator(".k2b-map-dialog__detail").boundingBox())!.y;
    const listTop = (await page.locator(".k2b-map-dialog__list").boundingBox())!.y;
    expect(detailTop).toBeLessThan(listTop);
    const nav = await page.locator(".k2b-map-dialog__detail").getByRole("link", { name: "In OpenStreetMap öffnen" }).boundingBox();
    expect(nav!.height).toBeGreaterThanOrEqual(44);
    // The fitted map ends above the resting sheet.
    const map = (await page.locator(".k2b-map-dialog__map").boundingBox())!;
    const sheet = (await side.boundingBox())!;
    expect(map.y + map.height).toBeLessThanOrEqual(sheet.y + 18);
    const handle = page.locator(".k2b-map-dialog__handle");
    expect(await handle.getAttribute("aria-label")).toBe("Liste vergrößern");
    await handle.click();
    await page.waitForFunction(() => document.querySelector(".k2b-map-dialog__side")?.getAttribute("data-sheet-detent") === "full");
    expect(await handle.getAttribute("aria-label")).toBe("Liste verkleinern");
    await handle.click();
    await page.waitForFunction(() => document.querySelector(".k2b-map-dialog__side")?.getAttribute("data-sheet-detent") === "peek");
    // A pin picked behind the lowered sheet raises it again.
    await page.locator('.k2b-map-dialog .k2b-map-view__pin[data-id="c"]').tap();
    await page.waitForFunction(() => document.querySelector(".k2b-map-dialog__side")?.getAttribute("data-sheet-detent") === "half");
    // Its details show from the top of the sheet, heading included.
    await page.waitForFunction(() => {
      const body = document.querySelector(".k2b-map-dialog__body")!.getBoundingClientRect();
      const name = document.querySelector(".k2b-map-dialog__detail h3");
      return name?.textContent === "Restaurierung Sedlmayr" && name.getBoundingClientRect().top >= body.top;
    });
    // The 22 px grip has a 44 px target.
    const grip = (await handle.boundingBox())!;
    const targets = await page.evaluate(
      ([x, top, bottom]) => [document.elementFromPoint(x!, top!)?.className, document.elementFromPoint(x!, bottom!)?.className],
      [grip.x + grip.width / 2, grip.y - 9, grip.y + grip.height + 9],
    );
    expect(targets).toEqual(["k2b-map-dialog__handle", "k2b-map-dialog__handle"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.locator(".k2b-map-dialog__close-float").tap();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  } finally {
    await page.context().close();
  }
});

test("the sheet changes height without a layout animation, also under reduced motion", async () => {
  const page = await open({ ...phone, reducedMotion: "reduce" }, "route");
  try {
    await tile(page).tap();
    await dialog(page).waitFor();
    const side = page.locator(".k2b-map-dialog__side");
    expect(await side.evaluate((element) => getComputedStyle(element).transitionProperty)).not.toContain("height");
    await page.locator(".k2b-map-dialog__handle").click();
    await page.waitForFunction(() => document.querySelector(".k2b-map-dialog__side")?.getAttribute("data-sheet-detent") === "full");
    expect(Math.round((await side.boundingBox())!.height)).toBe(844 - 64);
  } finally {
    await page.context().close();
  }
});
