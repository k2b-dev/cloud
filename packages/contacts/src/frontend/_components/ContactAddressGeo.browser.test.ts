import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import { availability, found, jana, type Scenario, startContactsGeoHarness } from "./ContactAddressGeo.browser-fixture";

type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let harness: Awaited<ReturnType<typeof startContactsGeoHarness>>;
beforeAll(async () => {
  harness = await startContactsGeoHarness();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await harness?.stop();
});
beforeEach(() => {
  Object.assign(harness.state, {
    autocomplete: "ok",
    locate: { state: "located", location: found },
    holdLocate: false,
    autocompleteRequests: [],
    locateRequests: 0,
    saves: [],
  });
});

const open = async (name: string, scenario: Scenario, width = 1440): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
  await page.goto(harness.url(name, scenario));
  await page.waitForFunction(() => "clientHeight" in window);
  return page;
};
const mapBox = (page: Page) => page.locator(".k2b-map-view").first().boundingBox();

test("a pending address keeps its reserved map place from the server render until the pin arrives", async () => {
  harness.state.holdLocate = true;
  const page = await open("pending", { view: "detail", contact: jana(null), availability: availability.configured });
  try {
    expect(await page.evaluate(() => (window as unknown as { serverHeight: number }).serverHeight)).toBe(
      await page.evaluate(() => (window as unknown as { clientHeight: number }).clientHeight),
    );
    await page.locator('span[role="status"]', { hasText: "Karte lädt …" }).waitFor();
    const before = await mapBox(page);
    expect(before?.height).toBe(160);
    harness.releaseLocate();
    await page.locator(".k2b-map-view__pin").waitFor();
    expect(await mapBox(page)).toEqual(before);
    expect(await page.locator('span[role="status"]', { hasText: "Karte lädt" }).count()).toBe(0);
    expect(harness.state.locateRequests).toBe(1);
    expect(await page.getByRole("link", { name: /Route planen/ }).getAttribute("href")).toBe(
      "https://www.openstreetmap.org/directions?route=%3B48.39841%2C9.99155",
    );
  } finally {
    await page.close();
  }
});

test("a failed lookup offers a retry in place; budget and missing setup ask nothing", async () => {
  harness.state.locate = "error";
  let page = await open("failed", { view: "detail", contact: jana(null), availability: availability.configured });
  try {
    await page.getByText("Karte nicht geladen").waitFor();
    const before = await mapBox(page);
    harness.state.locate = { state: "located", location: { status: "not_found", checkedAt: "2026-10-22T10:00:00.000Z" } };
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await page.getByText("Für diese Adresse kennt die Ortssuche keinen Punkt").waitFor();
    expect(await mapBox(page)).toEqual(before);
    expect(harness.state.locateRequests).toBe(2);
  } finally {
    await page.close();
  }

  page = await open("budget", { view: "detail", contact: jana(null), availability: availability.person });
  try {
    await page.getByText("Karte heute nicht verfügbar, ab 0:00 Uhr wieder").waitFor();
    expect((await mapBox(page))?.height).toBe(160);
  } finally {
    await page.close();
  }

  page = await open("off", { view: "detail", contact: jana(null), availability: availability.off });
  try {
    expect(await page.locator(".k2b-map-view").count()).toBe(0);
    expect(await page.getByRole("link", { name: /Route planen/ }).getAttribute("href")).toContain("openstreetmap.org/search?query=");
  } finally {
    await page.close();
  }
  expect(harness.state.locateRequests).toBe(2);
});

test("the street field suggests after a pause, picks with the keyboard and marks later edits", async () => {
  const page = await open("form", { view: "form", contact: jana(found), availability: availability.configured });
  try {
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    const hint = page.locator("p[id]", { hasText: /Vorschl|Adresse geändert|Eigene Eingabe/ }).first();
    await street.scrollIntoViewIfNeeded();
    await street.fill("");
    await street.pressSequentially("Frauenstr 28", { delay: 20 });
    await page.getByRole("option").nth(5).waitFor();
    expect(harness.state.autocompleteRequests.length).toBeLessThanOrEqual(2);
    expect(harness.state.autocompleteRequests.at(-1)).toBe("Frauenstr 28");
    const options = await page.getByRole("option").allTextContents();
    expect(options).toHaveLength(6);
    expect(options[5]).toContain("„Frauenstr 28“ so übernehmen");
    expect(await page.locator(".k2b-choice-footer").textContent()).toContain("Geoapify · OpenStreetMap");
    const hintBox = await hint.boundingBox();

    await street.press("Enter");
    expect(await street.inputValue()).toBe("Frauenstraße 28");
    expect(await page.getByRole("textbox", { name: /Postleitzahl/ }).inputValue()).toBe("89073");
    await expect(hint.textContent()).resolves.toContain("Aus Vorschlag übernommen");
    await settled(page);
    expect(await hint.boundingBox()).toEqual(hintBox);

    await page.getByRole("textbox", { name: /Postleitzahl/ }).fill("89079");
    await expect(hint.textContent()).resolves.toContain("Adresse geändert");
    await settled(page);
    expect(await hint.boundingBox()).toEqual(hintBox);

    // Escape closes the list and keeps the own text.
    await street.fill("Frauenstr 30");
    await page.getByRole("option").first().waitFor();
    await street.press("Escape");
    expect(await street.getAttribute("aria-expanded")).toBe("false");
    expect(await street.inputValue()).toBe("Frauenstr 30");
  } finally {
    await page.close();
  }
});

test("an exhausted budget answers in the list without asking; without setup the field is plain", async () => {
  let page = await open("form-budget", { view: "form", contact: jana(found), availability: availability.cloud });
  try {
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    await street.fill("Frauenstr 28");
    await page.getByText("Vorschläge bis 1. November aufgebraucht.").waitFor();
    await page.waitForTimeout(400);
    expect(harness.state.autocompleteRequests).toEqual([]);
  } finally {
    await page.close();
  }

  page = await open("form-off", { view: "form", contact: jana(found), availability: availability.off });
  try {
    expect(await page.getByRole("combobox", { name: /Straße und Hausnummer/ }).count()).toBe(0);
    await page.getByRole("textbox", { name: /Straße und Hausnummer/ }).fill("Frauenstr 28");
    await page.waitForTimeout(400);
    expect(harness.state.autocompleteRequests).toEqual([]);
  } finally {
    await page.close();
  }
});

test("the focused address editor saves a picked point with its fields and only the addresses", async () => {
  const page = await open("address", { view: "address", contact: jana(null), availability: availability.configured });
  try {
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    await street.fill("Frauenstr 28");
    await page.getByRole("option").nth(5).waitFor();
    await street.press("ArrowDown");
    await street.press("Enter");
    expect(await page.getByRole("textbox", { name: /Postleitzahl/ }).inputValue()).toBe("89079");
    const saved = page.waitForRequest((request) => request.method() === "PATCH");
    await page.getByRole("button", { name: "Speichern" }).click();
    await (await saved).response();
    expect(harness.state.saves).toHaveLength(1);
    const body = harness.state.saves[0] as {
      expectedUpdatedAt: string;
      addresses: { line1: string; postalCode: string; city: string; location?: { point: { lat: number } } }[];
    };
    // Only the addresses travel, with the revision the dialog read.
    expect(Object.keys(body).sort()).toEqual(["addresses", "expectedUpdatedAt"]);
    expect(body.expectedUpdatedAt).toBe("2026-10-22T10:00:00.000Z");
    expect(body.addresses).toHaveLength(1);
    expect(body.addresses[0]).toMatchObject({ line1: "Frauenstraße 28", postalCode: "89079", city: "Ulm-Wiblingen" });
    expect(body.addresses[0]!.location?.point.lat).toBeCloseTo(48.40841, 5);
  } finally {
    await page.close();
  }
});
