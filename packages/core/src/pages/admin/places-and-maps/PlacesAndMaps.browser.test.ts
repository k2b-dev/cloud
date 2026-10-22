import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import { placesAndMapsBrowserFixture } from "./PlacesAndMaps.browser-fixture";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof placesAndMapsBrowserFixture>>;
beforeAll(async () => {
  fixture = await placesAndMapsBrowserFixture();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

const views = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;
const tablet = { width: 820, height: 1180 };
const open = async (view: { width: number; height: number }, query: string) => {
  const page = await browser.newPage({
    viewport: view,
    reducedMotion: "reduce",
    isMobile: view.width < 600,
    hasTouch: view.width < 600,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${fixture.url}?${query}`);
  await page.locator('#places-and-maps-fixture[data-ready="true"]').waitFor();
  return { page, errors };
};
const root = (page: Page) => page.locator("[data-places-and-maps]");
/** Visible page text with every kind of space as a plain space (Intl uses no-break spaces in "46 %"). */
const textOf = async (page: Page) => (await root(page).innerText()).replace(/[\u00a0\u202f]/g, " ");
const section = (page: Page, name: string) =>
  page.locator("section.k2b-settings-section", { has: page.getByRole("heading", { name, exact: true }) });

test("every state fits a phone and a desktop in both themes and languages, with one number format", async () => {
  for (const view of [...views, tablet])
    for (const theme of ["light", "dark"])
      for (const locale of ["de", "en"])
        for (const state of ["eingerichtet", "aus", "budget-cloud", "budget-person", "verbrauch-fehler", "leer"]) {
          const { page, errors } = await open(view, `state=${state}&locale=${locale}&theme=${theme}`);
          try {
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect({ state, width: view.width, overflow: Math.max(0, overflow) }).toEqual({ state, width: view.width, overflow: 0 });
            const text = await textOf(page);
            if (state === "eingerichtet") {
              expect(await page.locator(".k2b-settings-page__heading > p").isVisible()).toBe(view.width > 600);
              expect(await page.locator(".k2b-text-input:has([data-geo-field]) .k2b-input-shell__icon").count()).toBe(0);
              expect(text).toContain(locale === "de" ? "41.230 / 90.000" : "41,230 / 90,000");
              expect(text).toContain(locale === "de" ? "Seit 19.10.2026 · von Lea Schulz · EU-Endpunkt" : "by Lea Schulz · EU endpoint");
              expect(text).toContain(locale === "de" ? "46 %" : "46%");
            }
            if (state === "budget-cloud" && locale === "de")
              expect(text).toContain("Monatsbudget erreicht. Karten und Ortssuche sind bis 1. November, 0:00 Uhr, aus.");
            if (state === "budget-person" && locale === "de") {
              expect(text).toContain("3 Personen haben heute ihre Tagesgrenze erreicht.");
              expect(text).toContain("Für sie geht es ab 0:00 Uhr weiter.");
            }
            if (state === "aus") {
              expect(await page.getByRole("button", { name: locale === "de" ? "Speichern" : "Save", exact: true }).isDisabled()).toBe(true);
              expect(text).toContain(
                locale === "de" ? "Verbrauch erscheint, sobald ein Schlüssel hinterlegt ist." : "Usage appears once a key",
              );
            }
            if (state === "leer" && locale === "de") expect(text).toContain("Noch kein Verbrauch in diesem Monat.");
            expect(errors).toEqual([]);
          } finally {
            await page.close();
          }
        }
}, 180_000);

test("replacing the key keeps the old one through refusal and outage, then saves after a successful check", async () => {
  for (const view of views) {
    const { page, errors } = await open(view, "state=eingerichtet&locale=de");
    try {
      await page.getByRole("button", { name: "Ersetzen", exact: true }).click();
      const field = page.getByLabel("Neuer Schlüssel", { exact: true });
      await expect(field.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
      expect(await root(page).innerText()).toContain("Der alte Schlüssel gilt, bis der neue geprüft ist.");
      // The key row stays visible while a replacement is typed and checked.
      expect(await root(page).innerText()).toContain("Schlüssel hinterlegt");

      await page.getByRole("button", { name: "Prüfen und ersetzen", exact: true }).click();
      expect(await root(page).innerText()).toContain("Füge zuerst den Schlüssel ein.");
      expect(await field.getAttribute("aria-invalid")).toBe("true");

      await field.fill("bad-0123456789abcdef");
      await page.getByRole("button", { name: "Prüfen und ersetzen", exact: true }).click();
      await root(page).getByText("Geoapify hat den Schlüssel abgelehnt.", { exact: true }).waitFor();
      expect(await root(page).innerText()).toContain("Nichts wurde gespeichert. Der bisherige Schlüssel bleibt aktiv.");
      await page.getByRole("button", { name: "Erneut prüfen", exact: true }).click();
      await root(page).getByText("Geoapify hat den Schlüssel abgelehnt.", { exact: true }).waitFor();

      await page.getByRole("button", { name: "Schlüssel ändern", exact: true }).click();
      expect(await field.inputValue()).toBe("bad-0123456789abcdef");
      await field.fill("down-0123456789abcdef");
      await page.getByRole("button", { name: "Prüfen und ersetzen", exact: true }).click();
      await root(page).getByText("Geoapify war nicht erreichbar.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Schlüssel ändern", exact: true }).click();

      await field.fill("ok-0123456789abcdef");
      const release = fixture.control.hold("/api/admin/core/geo/key");
      await page.getByRole("button", { name: "Prüfen und ersetzen", exact: true }).click();
      await page.getByRole("button", { name: /Wird geprüft/ }).waitFor();
      expect(await field.isDisabled()).toBe(true);
      release();
      await page.getByRole("button", { name: "Ersetzen", exact: true }).waitFor();
      expect(await root(page).innerText()).not.toContain("0123456789abcdef");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("a lost answer stays open for a key and is settled by the stored values for a budget", async () => {
  const { page } = await open(views[0], "state=aus&locale=en");
  try {
    fixture.control.dropNextAnswer = true;
    await page.getByLabel("Geoapify key", { exact: true }).fill("ok-fresh-key");
    await page.getByRole("button", { name: "Check and save key", exact: true }).click();
    // The key cannot be compared after the fact, so the page claims nothing and offers the safe repeat.
    await root(page).getByText("Cloud did not answer.", { exact: true }).waitFor();
    expect(await textOf(page)).toContain("It is unclear whether the key was saved.");
    await page.getByRole("button", { name: "Check again", exact: true }).click();
    await page.getByRole("button", { name: "Replace", exact: true }).waitFor();
    expect(await textOf(page)).toContain("by Lea Schulz");

    // The budget save landed although its answer was lost: the stored values match, so it counts as saved.
    fixture.control.dropNextAnswer = true;
    await page.getByLabel("Daily limit per person (credits)", { exact: true }).fill("400");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await root(page)
      .getByText(/^Saved at /)
      .waitFor();
    expect(await page.getByLabel("Daily limit per person (credits)", { exact: true }).inputValue()).toBe("400");
  } finally {
    fixture.control.dropNextAnswer = false;
    await page.close();
  }
}, 30_000);

test("removing the key asks first; keeping it changes nothing", async () => {
  for (const view of views) {
    const { page } = await open(view, "state=eingerichtet&locale=de");
    try {
      await page.getByRole("button", { name: "Entfernen", exact: true }).click();
      const text = await textOf(page);
      expect(text).toContain("Geoapify");
      expect(text).toContain("entfernen?");
      expect(text).toContain("Gespeicherte Karten zeigen nur noch Listen.");
      fixture.control.requests.length = 0;
      await page.getByRole("button", { name: "Behalten", exact: true }).click();
      await page.getByRole("button", { name: "Ersetzen", exact: true }).waitFor();
      expect(fixture.control.requests.filter((request) => request.method === "DELETE")).toHaveLength(0);

      await page.getByRole("button", { name: "Entfernen", exact: true }).click();
      await page.getByRole("button", { name: "Schlüssel entfernen", exact: true }).click();
      await root(page).getByText("Kein Schlüssel hinterlegt", { exact: true }).waitFor();
      expect(await page.getByLabel("Geoapify-Schlüssel", { exact: true }).isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: "Speichern", exact: true }).isDisabled()).toBe(true);
      expect(await root(page).innerText()).toContain("Verbrauch erscheint, sobald ein Schlüssel hinterlegt ist.");
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("an invalid limit is marked at its field, nothing is sent, and the value stays until corrected", async () => {
  for (const view of views) {
    const { page } = await open(view, "state=eingerichtet&locale=de");
    try {
      const daily = page.getByLabel("Tagesgrenze pro Person (Credits)", { exact: true });
      const top = async () => (await section(page, "Verbrauch").boundingBox())?.y;
      const before = await top();
      await daily.fill("120.000");
      fixture.control.requests.length = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.getByRole("button", { name: "Speichern", exact: true }).click();
        await root(page).getByText("Nicht gespeichert. Bitte die markierte Grenze prüfen.", { exact: true }).waitFor();
        expect(await daily.getAttribute("aria-invalid")).toBe("true");
        expect(await root(page).innerText()).toContain("Höchstens so hoch wie das Monatsbudget (90.000).");
        expect(await daily.inputValue()).toBe("120.000");
      }
      expect(fixture.control.requests.filter((request) => request.method === "PUT")).toHaveLength(0);
      // The reason replaces the hint in its own slot: nothing below moves.
      expect(await top()).toBe(before);

      await daily.fill("1,5");
      await page.getByRole("button", { name: "Speichern", exact: true }).click();
      expect(await root(page).innerText()).toContain("Bitte eine ganze Zahl eingeben.");

      await daily.fill("500");
      await page.getByRole("button", { name: "Speichern", exact: true }).click();
      await root(page)
        .getByText(/^Gespeichert um \d{2}:\d{2}$/)
        .waitFor();
      expect(await daily.getAttribute("aria-invalid")).toBeNull();
      const put = fixture.control.requests.find((request) => request.method === "PUT");
      expect(JSON.parse(put!.body)).toMatchObject({ plan: "free", monthlyCredits: 90000, personDailyCredits: 500 });
      expect(await top()).toBe(before);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("a custom plan asks for its own rate and allowance and checks them", async () => {
  const { page } = await open(views[0], "state=eingerichtet&locale=en");
  try {
    await page.getByRole("combobox", { name: "Plan at Geoapify" }).click();
    await page.getByRole("option", { name: "Custom plan" }).click();
    const rps = page.getByLabel("Requests per second", { exact: true });
    await rps.fill("0");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(await root(page).innerText()).toContain("At least 1.");
    expect(await root(page).innerText()).toContain("Not saved. Check the marked limit.");
    await rps.fill("8");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await root(page)
      .getByText(/^Saved at /)
      .waitFor();
  } finally {
    await page.close();
  }
}, 30_000);

test("usage that failed to load recovers in place, and loading keeps the final height", async () => {
  for (const view of views) {
    const { page } = await open(view, "state=verbrauch-fehler&locale=de");
    const usage = section(page, "Verbrauch");
    try {
      expect(await usage.innerText()).toContain("Der Verbrauch konnte nicht geladen werden.");
      expect(await usage.innerText()).toContain("Karten und Ortssuche laufen weiter. Budget und Grenzen gelten wie eingestellt.");
      fixture.control.failUsage = true;
      await usage.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      await usage.getByText("Der Verbrauch konnte nicht geladen werden.", { exact: true }).waitFor();
      fixture.control.failUsage = false;
      const release = fixture.control.hold("/api/admin/core/geo/usage");
      await usage.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
      await usage.locator("[aria-busy=true]").waitFor();
      // Loading shows the final lines, meters and shares; only the numbers wait.
      expect(await usage.innerText()).toContain("Kartenbilder");
      const loading = (await usage.boundingBox())!.height;
      release();
      await usage.getByText("41.230 / 90.000").waitFor();
      const ready = (await usage.boundingBox())!.height;
      expect({ width: view.width, difference: Math.abs(loading - ready) <= 1 }).toEqual({ width: view.width, difference: true });
    } finally {
      fixture.control.failUsage = false;
      await page.close();
    }
  }
}, 60_000);

test("settings that failed to load show a retry and recover with the same structure", async () => {
  const { page } = await open(views[0], "state=nicht-geladen&locale=de");
  try {
    expect(await root(page).innerText()).toContain("Die Einstellungen konnten nicht geladen werden.");
    fixture.control.failStatus = true;
    await page.getByRole("button", { name: "Erneut versuchen", exact: true }).first().click();
    await root(page).getByText("Die Einstellungen konnten nicht geladen werden.", { exact: true }).waitFor();
    fixture.control.failStatus = false;
    const release = fixture.control.hold("/api/admin/core/geo");
    await page.getByRole("button", { name: "Erneut versuchen", exact: true }).first().click();
    await page.locator("[data-places-and-maps] [aria-busy=true]").first().waitFor();
    expect(await page.getByRole("button", { name: "Speichern", exact: true }).isDisabled()).toBe(true);
    const loading = (await root(page).boundingBox())!.height;
    release();
    await root(page).getByText("Schlüssel hinterlegt", { exact: true }).waitFor();
    await root(page).getByText("41.230 / 90.000").waitFor();
    // Loading keeps the finished page's structure: the key row, fields, meters and shares hold their size.
    expect(Math.abs(loading - (await root(page).boundingBox())!.height)).toBeLessThanOrEqual(1);
    expect(await page.getByLabel("Monatsbudget (Credits)", { exact: true }).inputValue()).toBe("90.000");
  } finally {
    fixture.control.failStatus = false;
    await page.close();
  }
}, 30_000);
