import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
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
// A timed-out case must not keep issuing requests after the next fixture reset.
afterEach(async () => {
  harness.releaseLocate();
  harness.releaseSave();
  await Promise.all(browser.contexts().map((context) => context.close()));
});
beforeEach(() => {
  harness.reset();
  Object.assign(harness.state, {
    autocomplete: "ok",
    locate: { state: "located", location: found },
    holdLocate: false,
    autocompleteRequests: [],
    locateRequests: 0,
    saves: [],
    saveStatus: 200,
    holdSave: false,
  });
});

const open = async (name: string, scenario: Scenario, width = 1440, query = ""): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "Europe/Berlin", reducedMotion: "reduce" });
  await page.goto(`${harness.url(name, scenario)}${query}`);
  await page.waitForFunction(() => "clientHeight" in window);
  // Bring the navigated page forward: remote WebKit otherwise throttles frames used by actions and transitions.
  await page.bringToFront();
  return page;
};
const mapBox = (page: Page) => page.locator(".k2b-map-view").first().boundingBox();
const expectFocus = async (locator: ReturnType<Page["locator"]>) => {
  const state = await locator.evaluate((element) => ({
    focused: element === document.activeElement,
    activeTag: document.activeElement?.tagName,
    activeLabel: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent?.trim().slice(0, 60),
  }));
  expect(state).toMatchObject({ focused: true });
};

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
  const page = await open("form", {
    view: "workspace",
    contact: jana(found),
    initialAddressId: jana().addresses[0]!.id,
    availability: availability.configured,
  });
  try {
    await addressForm(page).waitFor();
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    const hint = page.locator("p[id]", { hasText: /Vorschl|Adresse geändert|Eigene Eingabe/ }).first();
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
    expect(await page.getByRole("textbox", { name: /PLZ/ }).inputValue()).toBe("89073");
    expect(await hint.textContent()).toContain("Aus Vorschlag übernommen");
    await settled(page);
    expect(await hint.boundingBox()).toEqual(hintBox);

    await page.getByRole("textbox", { name: /PLZ/ }).fill("89079");
    expect(await hint.textContent()).toContain("Adresse geändert");
    await settled(page);
    expect(await hint.boundingBox()).toEqual(hintBox);
  } finally {
    await page.close();
  }
});

test("Escape closes address suggestions and retains the typed text", async () => {
  const page = await open("form-escape", {
    view: "workspace",
    contact: jana(found),
    initialAddressId: jana().addresses[0]!.id,
    availability: availability.configured,
  });
  try {
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    await street.fill("Frauenstr 30");
    await page.getByRole("option").first().waitFor();
    await street.press("Escape");
    expect(await street.getAttribute("aria-expanded")).toBe("false");
    expect(await street.inputValue()).toBe("Frauenstr 30");
  } finally {
    await page.close();
  }
});

test.each(["cloud", "off"] as const)("address suggestions with %s availability send no provider request", async (availabilityKind) => {
  const page = await open(`form-${availabilityKind}`, {
    view: "workspace",
    contact: jana(found),
    initialAddressId: jana().addresses[0]!.id,
    availability: availability[availabilityKind],
  });
  try {
    if (availabilityKind === "cloud") {
      await page.getByRole("combobox", { name: /Straße und Hausnummer/ }).fill("Frauenstr 28");
      await page.getByText("Vorschläge bis 1. November aufgebraucht.").waitFor();
    } else {
      expect(await page.getByRole("combobox", { name: /Straße und Hausnummer/ }).count()).toBe(0);
      await page.getByRole("textbox", { name: /Straße und Hausnummer/ }).fill("Frauenstr 28");
    }
    await page.waitForTimeout(400);
    expect(harness.state.autocompleteRequests).toEqual([]);
  } finally {
    await page.close();
  }
});

test("the focused address editor saves a picked point with its fields and only the addresses", async () => {
  const page = await open("address", {
    view: "workspace",
    contact: jana(null),
    initialAddressId: jana().addresses[0]!.id,
    availability: availability.configured,
  });
  const routeLatitude = async () => {
    const href = await page.getByRole("link", { name: /Route planen/ }).getAttribute("href");
    return Number(new URL(href!, page.url()).searchParams.get("route")?.split(";")[1]?.split(",")[0]);
  };
  try {
    await page.getByRole("form", { name: "Adresse bearbeiten" }).waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(new URL(page.url()).searchParams.get("address")).toBe(jana().addresses[0]!.id);
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    await street.fill("Frauenstr 28");
    await page.getByRole("option").nth(5).waitFor();
    await street.press("ArrowDown");
    await street.press("Enter");
    expect(await page.getByRole("textbox", { name: /PLZ/ }).inputValue()).toBe("89079");
    const lookupsBeforeSave = harness.state.locateRequests;
    const saved = page.waitForRequest((request) => request.method() === "PATCH");
    await page.getByRole("button", { name: "Speichern" }).click();
    await (await saved).response();
    expect(harness.state.saves).toHaveLength(1);
    const body = harness.state.saves[0] as {
      expectedUpdatedAt: string;
      addresses: { line1: string; postalCode: string; city: string; location?: { point: { lat: number } } }[];
    };
    // Only the addresses travel, with the revision the workspace editor read.
    expect(Object.keys(body).sort()).toEqual(["addresses", "expectedUpdatedAt"]);
    expect(body.expectedUpdatedAt).toBe("2026-10-22T10:00:00.000Z");
    expect(body.addresses).toHaveLength(1);
    expect(body.addresses[0]).toMatchObject({ line1: "Frauenstraße 28", postalCode: "89079", city: "Ulm-Wiblingen" });
    expect(body.addresses[0]!.location?.point.lat).toBeCloseTo(48.40841, 5);
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.has("address")).toBe(false);
    expect(new URL(page.url()).searchParams.get("contact")).toBe("jana");
    await page.getByText("Ulm-Wiblingen", { exact: false }).first().waitFor();
    await expectFocus(page.locator(`[data-contact-address-edit="${jana().addresses[0]!.id}"]`));
    expect(await routeLatitude()).toBeCloseTo(48.40841, 5);
    expect(harness.state.locateRequests).toBe(lookupsBeforeSave);
    await page.reload();
    await page.getByText("Ulm-Wiblingen", { exact: false }).first().waitFor();
    expect(await routeLatitude()).toBeCloseTo(48.40841, 5);
    expect(harness.state.locateRequests).toBe(lookupsBeforeSave);
  } finally {
    await page.close();
  }
});

const editAddress = async (page: Page) => {
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).last().click();
  await page.getByRole("form", { name: "Adresse bearbeiten" }).waitFor();
  await expectFocus(page.getByRole("heading", { name: "Adresse bearbeiten", exact: true }));
};
const addressForm = (page: Page) => page.getByRole("form", { name: "Adresse bearbeiten" });

test("saving a manually changed address looks up its new location and reload keeps that point", async () => {
  const page = await open("workspace-manual-location", {
    view: "workspace",
    contact: jana(found),
    initialAddressId: jana().addresses[0]!.id,
    availability: availability.configured,
  });
  try {
    await addressForm(page).waitFor();
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    await street.fill("Frauenstraße 30");
    await street.press("Escape");
    harness.state.locate = { state: "located", location: { ...found, point: { lat: 49, lon: 10 } } };
    harness.state.holdLocate = true;
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.locator('span[role="status"]', { hasText: "Karte lädt …" }).waitFor();
    expect((await mapBox(page))?.height).toBe(160);
    harness.releaseLocate();
    const route = page.getByRole("link", { name: /Route planen/ });
    await page.waitForFunction(() => document.querySelector('a[href*="49%2C10"]') !== null);
    expect(await route.getAttribute("href")).toContain("49%2C10");
    expect(harness.state.locateRequests).toBe(1);
    await page.reload();
    await page.locator(".k2b-map-view__pin").waitFor();
    expect(await route.getAttribute("href")).toContain("49%2C10");
    expect(harness.state.locateRequests).toBe(1);
  } finally {
    harness.releaseLocate();
    await page.close();
  }
});

test("workspace address URL renders the same fields on SSR and reload while retaining the list", async () => {
  const page = await open("workspace-navigation", { view: "workspace", contact: jana(found), availability: availability.configured });
  try {
    await page.evaluate(() => {
      document.querySelector("[data-contact-row]")?.setAttribute("data-retained-row", "yes");
    });
    await editAddress(page);
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(await page.locator('[data-retained-row="yes"]').count()).toBe(1);
    expect(await page.locator('[data-contact-row][aria-current="true"]').count()).toBe(1);
    await page.reload();
    await addressForm(page).waitFor();
    expect(await page.evaluate(() => Reflect.get(window, "serverEditor"))).toEqual(
      await page.evaluate(() => Reflect.get(window, "clientEditor")),
    );
    expect(await page.getByRole("combobox", { name: /Straße und Hausnummer/ }).inputValue()).toBe("Frauenstraße 28");
  } finally {
    await page.close();
  }
});

test("workspace back/forward and cancel retain contact, book and list filters", async () => {
  const page = await open(
    "workspace-history",
    { view: "workspace", contact: jana(found), availability: availability.configured },
    1440,
    "&search=Berger&tag_id=work&page=2",
  );
  try {
    await editAddress(page);
    await page.goBack();
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    expect(await addressForm(page).count()).toBe(0);
    await expectFocus(page.locator(`[data-contact-address-edit="${jana().addresses[0]!.id}"]`));
    await page.goForward();
    await addressForm(page).waitFor();
    await page.getByRole("button", { name: "Abbrechen", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    const params = new URL(page.url()).searchParams;
    expect(params.get("contact")).toBe("jana");
    expect(params.get("contactBook")).toBe("team");
    expect(params.get("search")).toBe("Berger");
    expect(params.get("tag_id")).toBe("work");
    expect(params.get("page")).toBe("2");
    expect(params.has("address")).toBe(false);
    expect(harness.state.saves).toHaveLength(0);
    await expectFocus(page.locator(`[data-contact-address-edit="${jana().addresses[0]!.id}"]`));
  } finally {
    await page.close();
  }
});

test.each([500, 409] as const)("address ID after reorder preserves edits and recovery for status %s", async (status) => {
  const target = jana(found).addresses[0]!;
  const other = { ...target, id: "22222222-2222-4222-8222-222222222222", line1: "Andere Straße 1", position: 0 };
  const contact = { ...jana(found), birthday: "legacy-invalid-date", addresses: [other, { ...target, position: 1 }] };
  const page = await open("workspace-errors", { view: "workspace", contact, initialAddressId: target.id, availability: availability.off });
  try {
    const street = page.getByRole("textbox", { name: /Straße und Hausnummer/ });
    expect(await street.inputValue()).toBe("Frauenstraße 28");
    await street.fill("Frauenstraße 30");
    harness.state.saveStatus = status;
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    if (status === 500) {
      await page.getByRole("alert").filter({ hasText: "Speichern fehlgeschlagen" }).waitFor();
      expect(await street.inputValue()).toBe("Frauenstraße 30");
      expect(await street.isEditable()).toBe(true);
      expect(harness.state.saves[0]).toMatchObject({
        expectedUpdatedAt: contact.updatedAt,
        addresses: [{ line1: "Andere Straße 1" }, { line1: "Frauenstraße 30" }],
      });
      return;
    }
    await page.getByRole("button", { name: "Kontakt neu laden" }).waitFor();
    expect(await street.inputValue()).toBe("Frauenstraße 30");
    expect(await page.getByRole("button", { name: "Speichern", exact: true }).isDisabled()).toBe(true);
    expect(harness.state.saves[0]).toMatchObject({
      expectedUpdatedAt: contact.updatedAt,
      addresses: [{ line1: "Andere Straße 1" }, { line1: "Frauenstraße 30" }],
    });
    harness.setContact({
      ...contact,
      updatedAt: "2026-10-22T10:02:00.000Z",
      addresses: [other, { ...target, line1: "Aktuelle Straße 7", position: 1 }],
    });
    await page.getByRole("button", { name: "Kontakt neu laden" }).click();
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.has("address")).toBe(false);
    await page.getByText("Aktuelle Straße 7", { exact: true }).waitFor();
    await page.waitForFunction(() => "clientHeight" in window);
    await page.bringToFront();
    await page.locator(`[data-contact-address-edit="${target.id}"]`).click();
    expect(await page.getByRole("textbox", { name: /Straße und Hausnummer/ }).inputValue()).toBe("Aktuelle Straße 7");
    harness.state.saveStatus = 200;
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    expect(harness.state.saves.at(-1)).toMatchObject({ expectedUpdatedAt: "2026-10-22T10:02:00.000Z" });
  } finally {
    await page.close();
  }
});

test.each([true, false])("unavailable address URL offers return without write controls (readonly=%s)", async (readonly) => {
  const page = await open(`workspace-unavailable-${readonly}`, {
    view: "workspace",
    contact: jana(found),
    readonly,
    initialAddressId: readonly ? jana().addresses[0]!.id : "removed-address",
    availability: availability.off,
  });
  try {
    await page.getByRole("heading", { name: "Adresse nicht verfügbar" }).waitFor();
    expect(await addressForm(page).count()).toBe(0);
    await page.getByRole("button", { name: "Zurück zum Kontakt" }).click();
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    await expectFocus(page.getByRole("heading", { name: "Jana Berger", exact: true }));
    if (readonly) expect(await page.getByRole("button", { name: "Bearbeiten", exact: true }).count()).toBe(0);
    expect(harness.state.saves).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test("changing contact cancels an outstanding address save without reopening the old contact", async () => {
  const paul = { ...jana(found), id: "paul", firstName: "Paul", lastName: "Kremer", addresses: [] };
  const page = await open("workspace-switch", {
    view: "workspace",
    contact: jana(found),
    initialAddressId: jana().addresses[0]!.id,
    contacts: [jana(found), paul],
    availability: availability.off,
  });
  try {
    await addressForm(page).waitFor();
    await page.getByRole("textbox", { name: /Straße und Hausnummer/ }).fill("Frauenstraße 30");
    harness.state.holdSave = true;
    const request = page.waitForRequest((request) => request.method() === "PATCH");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    const pending = await request;
    expect(await page.getByRole("textbox", { name: /Straße und Hausnummer/ }).isDisabled()).toBe(true);
    const failed = page.waitForEvent("requestfailed", { predicate: (request) => request === pending });
    await page.locator("a[data-contact-row]", { hasText: "Paul Kremer" }).click();
    await failed;
    await page.getByRole("heading", { name: "Paul Kremer", exact: true }).waitFor();
    harness.releaseSave();
    await settled(page);
    expect(new URL(page.url()).searchParams.get("contact")).toBe("paul");
    expect(new URL(page.url()).searchParams.has("address")).toBe(false);
    expect(await addressForm(page).count()).toBe(0);
  } finally {
    harness.releaseSave();
    await page.close();
  }
});

test.each([1440, 768, 390])("focused editor keeps the workspace placement and form dimensions at %s px", async (width) => {
  const page = await open(
    `workspace-size-${width}`,
    { view: "workspace", contact: jana(found), availability: availability.configured },
    width,
  );
  try {
    if (width === 768) await page.locator("a[data-contact-row]").click();
    await editAddress(page);
    const form = addressForm(page);
    expect(await page.getByRole("button", { name: "Zurück zum Kontakt", exact: true }).isVisible()).toBe(width < 768);
    const geometry = await form.evaluate((element) => {
      const style = getComputedStyle(element);
      const inputs = [...element.querySelectorAll("input")].map((input) => input.getBoundingClientRect().toJSON());
      const controls = [...element.querySelectorAll(".k2b-input-shell, .k2b-combobox__input")].map((control) => {
        const box = control.getBoundingClientRect();
        return { height: box.height, left: box.x };
      });
      return {
        width: element.getBoundingClientRect().width,
        left: style.paddingLeft,
        top: style.paddingTop,
        gap: style.gap,
        inputs,
        controls,
      };
    });
    expect(geometry.top).toBe("18px");
    expect(geometry.gap).toBe("22px");
    expect(geometry.controls.map((control) => control.height)).toEqual([38, 38, 38, 38, 38]);
    expect(geometry.left).toBe(width < 768 ? "16px" : "28px");
    if (width === 1440) expect(geometry.width).toBe(760);
    if (width >= 768) {
      const row = page.locator("a[data-contact-row]");
      expect(await row.isVisible()).toBe(true);
      expect(await row.locator(".contacts-list__contact-points").isVisible()).toBe(false);
      const nameFits = await row
        .getByText("Jana Berger", { exact: true })
        .evaluate((element) => element.scrollWidth <= element.clientWidth);
      expect(nameFits).toBe(true);
      const listBox = await row.boundingBox();
      const formBox = await form.boundingBox();
      expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(formBox!.x);
    }
    if (width < 768) {
      expect(geometry.width).toBe(width);
      expect(geometry.controls[0]!.left).toBe(16);
      const panel = await page.locator("#k2b-workspace-detail-contacts-detail-panel").boundingBox();
      expect(panel?.y).toBe(0);
      expect(panel?.height).toBe(900);
      expect(geometry.inputs[2]!.y).toBeLessThan(geometry.inputs[3]!.y);
      expect(geometry.inputs[3]!.y).toBeLessThan(geometry.inputs[4]!.y);
    }
    expect(await page.locator("[data-contact-row]").count()).toBe(1);
  } finally {
    await page.close();
  }
});

test.each([1440, 768, 390])("reloading and closing an address editor restores the contact and focus at %s px", async (width) => {
  const page = await open(
    `workspace-return-${width}`,
    { view: "workspace", contact: jana(found), initialAddressId: jana().addresses[0]!.id, availability: availability.configured },
    width,
  );
  try {
    await page.reload();
    await page.waitForFunction(() => "clientHeight" in window);
    await page.bringToFront();
    await addressForm(page).waitFor({ state: "visible" });
    if (width >= 768) {
      const listBox = await page.locator("a[data-contact-row]").boundingBox();
      const formBox = await addressForm(page).boundingBox();
      expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(formBox!.x);
    }
    await page.getByRole("button", { name: width < 768 ? "Zurück zum Kontakt" : "Abbrechen", exact: true }).click();
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    expect(new URL(page.url()).searchParams.has("address")).toBe(false);
    const action = page.locator(`[data-contact-address-edit="${jana().addresses[0]!.id}"]`);
    expect(await action.isVisible()).toBe(true);
    expect(await action.evaluate((element) => element === document.activeElement)).toBe(true);
    const actionBox = await page.locator(`[data-contact-address-edit="${jana().addresses[0]!.id}"]`).boundingBox();
    const panelBox = await page.locator("#k2b-workspace-detail-contacts-detail-panel").boundingBox();
    expect(actionBox!.y).toBeGreaterThanOrEqual(panelBox!.y);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height);
  } finally {
    await page.close();
  }
});

test("saving a tablet address deep link keeps the selected contact visible and restores focus", async () => {
  const contact = jana(found);
  const page = await open(
    "workspace-tablet-save",
    {
      view: "workspace",
      contact,
      initialAddressId: contact.addresses[0]!.id,
      availability: availability.configured,
    },
    768,
  );
  try {
    await addressForm(page).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor({ state: "visible" });
    const action = page.locator(`[data-contact-address-edit="${contact.addresses[0]!.id}"]`);
    expect(await action.isVisible()).toBe(true);
    expect(await action.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(new URL(page.url()).searchParams.has("address")).toBe(false);
    expect(harness.state.saves).toHaveLength(1);
  } finally {
    await page.close();
  }
});

test.each(["empty", "error"] as const)("workspace suggestions recover from %s without losing own input", async (state) => {
  const page = await open(`workspace-suggestions-${state}`, {
    view: "workspace",
    contact: jana(found),
    initialAddressId: jana().addresses[0]!.id,
    availability: availability.configured,
  });
  try {
    await addressForm(page).waitFor();
    harness.state.autocomplete = state;
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    await street.fill("Eigene Straße 12");
    await page.getByText(state === "empty" ? "Keine passende Adresse gefunden." : /Vorschläge gerade nicht verfügbar/).waitFor();
    expect(await street.inputValue()).toBe("Eigene Straße 12");
    if (state === "error") {
      harness.state.autocomplete = "ok";
      await page.getByRole("button", { name: "Erneut versuchen" }).click();
      await page.getByRole("option").nth(5).waitFor();
    }
    await street.press("Escape");
    await page.getByRole("textbox", { name: /PLZ/ }).fill("89073");
    await page.getByRole("button", { name: "Speichern", exact: true }).click();
    await page.getByRole("heading", { name: "Jana Berger", exact: true }).waitFor();
    expect(harness.state.saves[0]).toMatchObject({ addresses: [{ line1: "Eigene Straße 12" }] });
  } finally {
    await page.close();
  }
});

test("phone workspace puts own entry first and preserves it on keyboard selection", async () => {
  const page = await open(
    "workspace-phone-own",
    { view: "workspace", contact: jana(found), initialAddressId: jana().addresses[0]!.id, availability: availability.configured },
    390,
  );
  try {
    await addressForm(page).waitFor();
    const street = page.getByRole("combobox", { name: /Straße und Hausnummer/ });
    await street.fill("Frauenstr 28");
    await page.getByRole("option").nth(5).waitFor();
    expect(await page.getByRole("option").first().textContent()).toContain("„Frauenstr 28“ so übernehmen");
    expect(await page.locator(".k2b-choice-footer").textContent()).not.toContain("Enter");
    await page.getByRole("option").first().click();
    expect(await street.inputValue()).toBe("Frauenstr 28");
    await page.getByText("Eigene Eingabe · Cloud sucht die Lage beim Speichern").waitFor();
  } finally {
    await page.close();
  }
});

test("URL reconciliation reads the current contact instead of reusing its stale SSR seed", async () => {
  const contact = jana(found);
  const page = await open("workspace-canonical-read", { view: "workspace", contact, availability: availability.off });
  try {
    harness.setContact({
      ...contact,
      updatedAt: "2026-10-22T10:03:00.000Z",
      addresses: [{ ...contact.addresses[0]!, line1: "Aktuelle Adresse 9" }],
    });
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("contacts-detail-select", {
          detail: { item: null, itemKey: "jana", bookId: "team" },
        }),
      ),
    );
    await page.getByText("Aktuelle Adresse 9", { exact: true }).waitFor();
    await editAddress(page);
    expect(await page.getByRole("textbox", { name: /Straße und Hausnummer/ }).inputValue()).toBe("Aktuelle Adresse 9");
  } finally {
    await page.close();
  }
});
