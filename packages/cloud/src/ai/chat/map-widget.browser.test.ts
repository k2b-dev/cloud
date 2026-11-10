import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { mapAddress } from "../map.test-fixture";
import { startMapBrowserFixture } from "../map-browser.test-fixture";
import type { AiMapCommand } from "../map-contracts";

// Each case opens the map dialog and runs a flow through it, some with a reload; one step keeps Playwright's own wait.
setDefaultTimeout(30_000);

let fixture: Awaited<ReturnType<typeof startMapBrowserFixture>>;
let browser: Browser;
beforeAll(async () => {
  fixture = await startMapBrowserFixture();
  browser = await launchBrowser();
}, 60000);
afterAll(async () => {
  await browser?.close();
  await fixture?.stop();
});
declare global {
  interface Window {
    mapFollowup: (command: AiMapCommand) => Promise<void>;
  }
}
const open = async (scenario: string, width = 1440, extra = "") => {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
    timezoneId: "Europe/Berlin",
    geolocation: { latitude: 48.4, longitude: 10 },
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  const errors = pageErrors(page);
  await page.goto(`${fixture.server.url}?scenario=${scenario}${extra}`);
  await page.locator(".ai-map").waitFor();
  await settled(page);
  expect(errors).toEqual([]);
  return { page, context };
};
/** The chat's tile: it keeps its place and size through every change of the map. */
const dimensions = async (page: Page) =>
  page.locator(".ai-map").evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { top: b.top, height: b.height, width: b.width };
  });
const tile = (page: Page) => page.locator(".ai-map .k2b-map-tile__open");
const dialog = (page: Page) => page.locator("dialog[open]");
const openDialog = async (page: Page) => {
  await tile(page).click();
  await dialog(page).locator(".k2b-map-dialog").waitFor();
  return dialog(page);
};
/** Route tools sit in the dialog's "More actions" menu. */
const menu = async (page: Page, name: string) => {
  await dialog(page).getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
};
const option = (page: Page, name: string | RegExp) => dialog(page).getByRole("option", { name });

test("places open from a still tile; keyboard, list and map share the selection; unknown hours", async () => {
  fixture.get("places-keyboard").map.groups[0]!.places[5]!.website = "https://[";
  const { page, context } = await open("places-keyboard");
  const errors = pageErrors(page);
  try {
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("6 Orte");
    expect(await page.locator(".ai-map button.k2b-map-view__pin").count()).toBe(0);
    await tile(page).focus();
    await page.keyboard.press("Enter");
    const d = dialog(page);
    await d.locator(".k2b-map-dialog").waitFor();
    expect(await d.locator(".k2b-map-dialog__place").count()).toBe(6);
    const list = d.getByRole("listbox", { name: "Orte" });
    await list.focus();
    await page.keyboard.press("End");
    await d.locator(".k2b-map-dialog__detail").getByText("Öffnungszeiten unbekannt", { exact: true }).waitFor();
    await page.keyboard.press("Home");
    expect(await d.locator(".k2b-map-dialog__place").first().getAttribute("aria-selected")).toBe("true");
    expect(await d.locator(".k2b-map-dialog__detail").innerText()).toContain("heute 10:00–17:00 Uhr");
    await d.locator('[data-id="museum-2"]').click();
    expect(await d.locator(".k2b-map-dialog__place").nth(2).getAttribute("aria-selected")).toBe("true");
    // "Als Notebook speichern" is gone (decision F6); places keep "Route hierher" and "Mehr in der Nähe".
    expect(await page.getByRole("button", { name: "Als Notebook speichern" }).count()).toBe(0);
    expect(await d.getByRole("button", { name: "Route hierher" }).count()).toBe(1);
    expect(await d.getByRole("button", { name: "Mehr in der Nähe" }).count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.classList.contains("k2b-map-tile__open"));
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Back closes the map onto the tile; a reload with the map open opens it again", async () => {
  const { page, context } = await open("places-history");
  try {
    await openDialog(page);
    const mapId = fixture.get("places-history").map.id;
    expect(new URL(page.url()).searchParams.get("map")).toBe(mapId);
    await page.goBack();
    await page.waitForFunction(() => !document.querySelector("dialog[open]"));
    await page.waitForFunction(() => document.activeElement?.classList.contains("k2b-map-tile__open"));
    expect(new URL(page.url()).searchParams.get("scenario")).toBe("places-history");
    expect(new URL(page.url()).searchParams.has("map")).toBe(false);
    await openDialog(page);
    await page.reload();
    await dialog(page).locator(".k2b-map-dialog__place").first().waitFor();
    await dialog(page).getByRole("button", { name: "Schließen" }).first().click();
    await page.waitForFunction(() => !document.querySelector("dialog[open]") && !new URL(location.href).searchParams.has("map"));
  } finally {
    await context.close();
  }
});

describe.each([1440, 390])("saved map follow-up at %i", (width) => {
  let opened: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    opened = await open(`places-followup-${width}`, width);
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  test("retains the original tile and conversation; the dialog lists both groups after reload", async () => {
    const { page } = opened;
    const before = await dimensions(page);
    expect(before.height).toBe(240);
    await page.evaluate(() =>
      window.mapFollowup({ type: "search", search: { title: "Cafés", categories: ["cafe"], placeId: "museum-0" } }),
    );
    await page.getByRole("link", { name: /Zur Karte/ }).waitFor();
    await settled(page);
    expect(await page.locator(".ai-map").count()).toBe(1);
    expect(await dimensions(page)).toEqual(before);
    expect(await page.locator("body").innerText()).toContain("Deine bisherigen Antworten bleiben erhalten");
    await page.reload();
    await page.locator(".ai-map").waitFor();
    await settled(page);
    expect(await dimensions(page)).toEqual(before);
    const d = await openDialog(page);
    await d.locator('.k2b-map-dialog__place[data-tone="second"]').first().waitFor();
    expect(await d.locator('.k2b-map-dialog__place[data-tone="second"]').count()).toBe(4);
    expect(await d.locator(".k2b-map-dialog__group").allTextContents()).toEqual(["Museen", "Cafés"]);
    expect(await d.locator(".k2b-map-dialog__place").count()).toBe(10);
  });
});

describe.each(["/app/assistant", "/app/assistant/panel"])("older map navigation from %s", (path) => {
  describe.each([1440, 390])("at %i", (width) => {
    const scenario = `places-jump-${path.endsWith("panel") ? "panel" : "full"}-${width}`;
    let opened: Awaited<ReturnType<typeof open>>;
    beforeAll(async () => {
      opened = await open(scenario, width);
    });
    afterAll(async () => {
      await opened?.context.close();
    });
    test("keeps the host route when loading history", async () => {
      const { page } = opened;
      const errors = pageErrors(page);
      await page.evaluate(() =>
        window.mapFollowup({ type: "search", search: { title: "Cafés", categories: ["cafe"], placeId: "museum-0" } }),
      );
      const jump = page.getByRole("link", { name: /Zur Karte/ });
      await jump.waitFor();
      fixture.get(scenario).map.anchorSeq = 77;
      await page.evaluate(
        ({ path, scenario }) => {
          history.replaceState(null, "", `${path}?scenario=${scenario}`);
          document.querySelector(".ai-map")?.remove(); // Original turn is outside the loaded history window.
          const output = document.createElement("output");
          output.id = "map-navigation";
          document.body.append(output);
          window.addEventListener(
            "cloud.search.navigate",
            (event) => {
              output.textContent = event.detail.target.href;
              event.detail.handled = Promise.resolve(true);
            },
            { once: true },
          );
        },
        { path, scenario },
      );
      const initialHref = new URL((await jump.getAttribute("href"))!, page.url());
      expect(initialHref.pathname).toBe(path);
      await jump.click();
      await page.waitForFunction(() => Boolean(document.getElementById("map-navigation")?.textContent));
      const target = new URL((await page.locator("#map-navigation").textContent())!);
      expect(target.pathname).toBe(path);
      expect(target.searchParams.get("conversation")).toBe(scenario);
      expect(target.searchParams.get("message")).toBe("77");
      expect(target.hash).toBe(`#assistant-map-${fixture.get(scenario).map.id}`);
      expect(new URL(page.url()).pathname).toBe(path);
      expect(errors).toEqual([]);
    });
  });
});

test("a follow-up link jumps to the tile and focuses it", async () => {
  const { page, context } = await open("places-jump-here");
  try {
    await page.evaluate(() =>
      window.mapFollowup({ type: "search", search: { title: "Cafés", categories: ["cafe"], placeId: "museum-0" } }),
    );
    await page.getByRole("link", { name: /Zur Karte/ }).click();
    await page.waitForFunction(() => document.activeElement?.classList.contains("k2b-map-tile__open"));
  } finally {
    await context.close();
  }
});

describe.each([1440, 390])("named place search at %i", (width) => {
  const scenario = `route-name-${width}`;
  let opened: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    opened = await open(scenario, width);
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  test("submits the provider name, lists the results and restores them after reload", async () => {
    const { page } = opened;
    const before = await dimensions(page);
    expect(before.height).toBe(240);
    await openDialog(page);
    await menu(page, "Stopp einfügen");
    await dialog(page).getByLabel("Ortsname (optional)", { exact: true }).fill(" Wasserfall ");
    await dialog(page).getByRole("button", { name: "Suchen", exact: true }).click();
    await option(page, /^Fiktiver Wasserfall 3/).click();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "search",
      insert: true,
      search: { name: "Wasserfall", categories: ["attraction"], along: { fromKm: 0, toKm: 162 } },
    });
    expect(fixture.get(scenario).map.lastSearch?.name).toBe("Wasserfall");
    expect(fixture.placeSearches.at(-1)).toMatchObject({ name: "Wasserfall", categories: ["attraction"], limit: 5 });
    expect(await dialog(page).locator(".k2b-map-dialog__place").count()).toBe(5);
    // settled: the tile's box behind the dialog depends only on its fixed size, not on any running animation.
    expect(await dimensions(page)).toEqual(before);
    // The map stays open in its own history entry through the reload.
    await page.reload();
    await dialog(page).locator(".k2b-map-dialog").waitFor();
    await menu(page, "Stopp einfügen");
    expect(await dialog(page).getByLabel("Ortsname (optional)", { exact: true }).inputValue()).toBe("Wasserfall");
    await option(page, /^Fiktiver Wasserfall 3/).click();
  });
});

describe.each([1440, 390])("insert search and preview at %i", (width) => {
  const scenario = `route-insert-${width}`;
  let opened: Awaited<ReturnType<typeof open>>;
  let before: Awaited<ReturnType<typeof dimensions>>;
  beforeAll(async () => {
    opened = await open(scenario, width);
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  // Ordered phases retain the selected stop, the discarded preview and the tile.
  test("searches, selects a stop and discards its real delta preview", async () => {
    const { page } = opened;
    before = await dimensions(page);
    await openDialog(page);
    await menu(page, "Stopp einfügen");
    await dialog(page).getByLabel("Ortsname (optional)", { exact: true }).fill("Wasserfall");
    await dialog(page).getByRole("button", { name: "Suchen", exact: true }).click();
    await option(page, /^Fiktiver Wasserfall 3/).click();
    await dialog(page).getByRole("button", { name: "Vorschau für Fiktiver Wasserfall 3", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Verwerfen", exact: true }).waitFor();
    const facts = await dialog(page).locator(".k2b-map-dialog__facts").innerText();
    expect(facts).toContain("+12 min");
    expect(facts).toContain("+4 km");
    // The proposed stop is a "+" pin and a row until it is accepted or discarded.
    expect(await dialog(page).locator(".k2b-map-dialog__place .k2b-map-dialog__mark").allTextContents()).toContain("+");
    expect(fixture.get(scenario).map.route?.stops).toHaveLength(4);
    await dialog(page).getByRole("button", { name: "Verwerfen", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Verwerfen", exact: true }).waitFor({ state: "detached" });
    expect(await dimensions(page)).toEqual(before);
  });
  test("accepts the selected stop and restores the route with timestamped undo", async () => {
    const { page } = opened;
    await menu(page, "Stopp einfügen");
    await dialog(page).getByRole("button", { name: "Suchen", exact: true }).click();
    await option(page, /^Fiktiver Wasserfall 3/).click();
    await dialog(page).getByRole("button", { name: "Vorschau für Fiktiver Wasserfall 3", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Fiktiver Wasserfall 3 einfügen", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
    expect(fixture.get(scenario).map.route?.stops).toHaveLength(5);
    expect(await dialog(page).locator(".ai-map__receipt time").getAttribute("datetime")).toBe("2026-10-19T14:31:00.000Z");
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("A → B → C → D → E");
    await dialog(page).getByRole("button", { name: "Rückgängig", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ai-map__receipt button"));
    expect(fixture.get(scenario).map.route?.stops).toHaveLength(4);
    expect(await dimensions(page)).toEqual(before);
  });
});

test("ambiguity calculates only after choosing a server candidate; options preserve scope", async () => {
  const { page, context } = await open("route-ambiguous");
  try {
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("Welcher Ort ist gemeint?");
    await openDialog(page);
    const calls = fixture.geo.calls.length;
    await dialog(page).getByRole("listbox", { name: "Welcher Ort ist gemeint?" }).waitFor();
    await option(page, /^2 Beispielgasse/).click();
    expect(fixture.geo.calls.length).toBe(calls);
    await dialog(page)
      .getByRole("button", { name: /2 Beispielgasse.*Als Stopp übernehmen/ })
      .click();
    await dialog(page).getByRole("listbox", { name: "Welcher Ort ist gemeint?" }).waitFor({ state: "detached" });
    expect(fixture.geo.calls.slice(calls)).toContain("calculate");
    await menu(page, "Optionen");
    await dialog(page).getByLabel("Autobahn", { exact: true }).click();
    await dialog(page).getByRole("button", { name: "Vorschau berechnen" }).click();
    await dialog(page).getByRole("button", { name: "Verwerfen", exact: true }).waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "preview",
      change: { type: "options", options: { mode: "car", avoid: ["highways"] } },
    });
  } finally {
    await context.close();
  }
});

test("unconfigured state makes no map/provider calls and hides admin links", async () => {
  const start = fixture.calls.length;
  const { page, context } = await open("places-unconfigured");
  try {
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("Karten sind nicht eingerichtet");
    await openDialog(page);
    expect(await dialog(page).innerText()).toContain("Orte und Karten sind nicht eingerichtet");
    expect(fixture.calls.slice(start)).toEqual([]);
    expect(await page.getByRole("link", { name: "Orte und Karten einrichten" }).count()).toBe(0);
  } finally {
    await context.close();
  }
});

test.each(["person", "cloud"])("budget %s shows reset and retained source list", async (scope) => {
  const { page, context } = await open(`places-budget-${scope}`);
  try {
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("Kartengrenze erreicht");
    await openDialog(page);
    const text = await dialog(page).innerText();
    expect(text).toContain(scope === "person" ? "Tagesgrenze" : "Monatsbudget");
    expect(text).toContain("Wieder verfügbar");
    expect(await dialog(page).locator(".k2b-map-dialog__place").count()).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("empty search widens, a failure retries, and the tile keeps its size in dark and the panel", async () => {
  const { page, context } = await open("places-empty", 768, "&theme=dark");
  try {
    await openDialog(page);
    await dialog(page).getByRole("button", { name: "Umkreis 10 km" }).click();
    await dialog(page).locator(".k2b-map-dialog__place").first().waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({ type: "search", search: { categories: ["museum"], near: "Ulm", radiusMeters: 10000 } });
    await page.goto(`${fixture.server.url}?scenario=places-failure&panel=true&theme=dark`);
    await page.locator(".ai-map").waitFor();
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("Karte nicht geladen");
    await openDialog(page);
    await dialog(page).getByRole("button", { name: "Erneut versuchen" }).click();
    await dialog(page).locator(".k2b-map-dialog__place").first().waitFor();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page);
    expect((await dimensions(page)).height).toBe(240);
  } finally {
    await context.close();
  }
});

describe.each([1440, 390, 768])("SSR and first browser render at %i", (width) => {
  let opened: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    opened = await open(`places-ssr-${width}`, width, "&ssr=1");
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  test("reserve the same tile", async () => {
    const { page } = opened;
    const server = await dimensions(page);
    const pill = await page.locator(".ai-map .k2b-map-tile__summary").innerText();
    await page.goto(`${fixture.server.url}?scenario=places-ssr-${width}`);
    await page.locator(".ai-map .k2b-map-tile__open:not([disabled])").waitFor();
    await settled(page);
    expect(await dimensions(page)).toEqual(server);
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toBe(pill);
  });
});

test("location denial keeps the map and offers an address route", async () => {
  const { page, context } = await open("places-location");
  try {
    await page.evaluate(() =>
      Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
        configurable: true,
        value: (_ok: unknown, fail: (error: unknown) => void) => fail({ code: 1, PERMISSION_DENIED: 1 }),
      }),
    );
    await openDialog(page);
    await dialog(page).getByRole("button", { name: "Ich bin hier", exact: true }).click();
    await dialog(page).getByText("Standort nicht erlaubt · im Browser freigeben", { exact: true }).waitFor();
    await dialog(page).getByRole("button", { name: "Route hierher", exact: true }).click();
    await dialog(page).getByLabel("Startort", { exact: true }).fill("Fiktiver Hauptbahnhof");
    await dialog(page).getByRole("button", { name: "Route planen", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Weitere Aktionen", exact: true }).waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "route",
      stops: [{ address: "Fiktiver Hauptbahnhof" }, { placeId: "museum-0" }],
    });
  } finally {
    await context.close();
  }
});

test("browser location routes to the selected verified place", async () => {
  const { page, context } = await open("places-location-success");
  try {
    await openDialog(page);
    await dialog(page).getByRole("button", { name: "Ich bin hier", exact: true }).click();
    await dialog(page).locator(".k2b-map-view__me").waitFor();
    await dialog(page).getByRole("button", { name: "Route hierher", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Weitere Aktionen", exact: true }).waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "location",
      destinationId: "museum-0",
      point: { lat: 48.4, lon: 10 },
    });
  } finally {
    await context.close();
  }
});

test("offline, Route hierher is unavailable with its reason while navigation stays", async () => {
  const { page, context } = await open("places-offline");
  try {
    await openDialog(page);
    await context.setOffline(true);
    const detail = dialog(page).locator(".k2b-map-dialog__detail");
    await detail.getByText("Ohne Verbindung keine neue Route. Die Navi-App geht weiter.").waitFor();
    expect(await detail.getByRole("button", { name: "Route hierher" }).getAttribute("aria-disabled")).toBe("true");
    expect(await detail.getByRole("link", { name: "In OpenStreetMap öffnen" }).getAttribute("href")).toContain("openstreetmap.org");
    await context.setOffline(false);
  } finally {
    await context.close();
  }
});

test("whole and per-leg preferences calculate a real preview and retain the leg label after accept", async () => {
  const { page, context } = await open("route-per-leg");
  try {
    await openDialog(page);
    await menu(page, "Optionen");
    await dialog(page).getByRole("combobox", { name: "Gilt für", exact: true }).click();
    await page.getByRole("option", { name: "B → C", exact: true }).click();
    await dialog(page).getByLabel("Autobahn", { exact: true }).click();
    await dialog(page).getByRole("button", { name: "Vorschau berechnen", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Etappe ohne Autobahn", exact: true }).waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "preview",
      change: { type: "options", leg: { fromStopId: "stop-1", toStopId: "stop-2" } },
    });
    await dialog(page).getByRole("button", { name: "Etappe ohne Autobahn", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
    // Each stop's row names the leg that reaches it: B → C now avoids the highway, A → B does not.
    const rows = dialog(page).locator(".k2b-map-dialog__place");
    expect(await rows.nth(2).innerText()).toContain("ohne Autobahn");
    expect(await rows.nth(1).innerText()).not.toContain("ohne Autobahn");
  } finally {
    await context.close();
  }
});

test("optimize and move keep old letters until accept and render both stop orders", async () => {
  const { page, context } = await open("route-optimize");
  try {
    await openDialog(page);
    await menu(page, "Reihenfolge optimieren");
    await dialog(page).getByRole("button", { name: "Neue Reihenfolge übernehmen", exact: true }).waitFor();
    expect(await dialog(page).locator(".k2b-map-dialog__facts").innerText()).toContain("-12 min");
    expect(await dialog(page).locator(".ai-map__order li").allTextContents()).toEqual([
      "Ulm",
      "Bad Urach",
      "Blautopf",
      "Stuttgart",
      "Ulm",
      "Blautopf",
      "Bad Urach",
      "Stuttgart",
    ]);
    expect(await dialog(page).locator('[data-id="stop-1"]').innerText()).toBe("B");
    await dialog(page).getByRole("button", { name: "Neue Reihenfolge übernehmen", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
    expect(await dialog(page).locator('[data-id="stop-1"]').innerText()).toBe("C");
    await page.evaluate(() => window.mapFollowup({ type: "preview", change: { type: "move", stopId: "stop-1", toIndex: 1 } }));
    await dialog(page).getByRole("button", { name: "Stopp verschieben", exact: true }).waitFor();
    expect(fixture.get("route-optimize").map.route?.stops[1]?.id).toBe("stop-2");
    await dialog(page).getByRole("button", { name: "Stopp verschieben", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ai-map__confirm"));
    expect(fixture.get("route-optimize").map.route?.stops[1]?.id).toBe("stop-1");
  } finally {
    await context.close();
  }
});

test("along-route window reaches server search; the stop's navigation link keeps its destination", async () => {
  const { page, context } = await open("route-along");
  try {
    await openDialog(page);
    await menu(page, "Unterwegs essen");
    await dialog(page).getByRole("button", { name: "Suchen", exact: true }).click();
    const along = option(page, /km 44/);
    await along.waitFor();
    expect(await along.innerText()).toContain("0,3 km");
    expect(fixture.get("route-along").map.groups).toHaveLength(1);
    expect(fixture.commands.at(-1)).toMatchObject({ type: "search", search: { along: { fromKm: 40, toKm: 80 } } });
    await dialog(page).locator(".k2b-map-dialog__place").first().click();
    expect(
      await dialog(page).locator(".k2b-map-dialog__detail").getByRole("link", { name: "In OpenStreetMap öffnen" }).getAttribute("href"),
    ).toContain("openstreetmap.org");
    expect(await dialog(page).locator(".k2b-map-dialog__provenance").innerText()).toContain("Zeiten ohne Verkehr");
  } finally {
    await context.close();
  }
});

test.each(["places", "route"])("loading %s keeps the tile's size and does not open yet", async (kind) => {
  const { page, context } = await open(`${kind}-loading`);
  try {
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("Orte und Route werden geladen");
    expect(await tile(page).isDisabled()).toBe(true);
    expect((await dimensions(page)).height).toBe(240);
  } finally {
    await context.close();
  }
});

test("retry in an unconfigured map never calls a provider; configuration links require administrator state", async () => {
  const { page, context } = await open("places-unconfigured-admin");
  try {
    await openDialog(page);
    await dialog(page).getByRole("link", { name: "Orte und Karten einrichten", exact: true }).waitFor();
    const before = fixture.geo.calls.length;
    await dialog(page).getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ai-map")?.getAttribute("aria-busy") === "false");
    expect(fixture.geo.calls.slice(before)).toEqual(["availability"]);
  } finally {
    await context.close();
  }
});

test("stale map actions offer reload without running a provider", async () => {
  const scenario = "route-stale";
  const { page, context } = await open(scenario);
  try {
    const stored = fixture.get(scenario);
    fixture.states.set(scenario, { ...stored, map: { ...stored.map, revision: stored.map.revision + 1 } });
    const before = fixture.geo.calls.length;
    await openDialog(page);
    await menu(page, "Reihenfolge optimieren");
    await dialog(page).getByRole("alert").filter({ hasText: "Diese Karte wurde inzwischen geändert" }).waitFor();
    expect(fixture.geo.calls.length).toBe(before);
    await dialog(page).getByRole("button", { name: "Aktuellen Stand laden", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('dialog[open] [role="alert"]'));
    expect(fixture.geo.calls.length).toBe(before);
  } finally {
    await context.close();
  }
});

test.each([390, 1440])("routing overrun shows charged costs and waits for an explicit resume at %i", async (width) => {
  const scenario = `route-overrun-${width}`;
  const before = fixture.commands.length;
  const { page, context } = await open(scenario, width);
  try {
    expect(await page.locator(".ai-map .k2b-map-tile__summary").innerText()).toContain("Kosten bestätigen");
    await openDialog(page);
    await dialog(page).getByText("Letzter Versuch: 20 Credits gebucht. Mit unklarem Ergebnis reserviert: 2.", { exact: true }).waitFor();
    expect(fixture.commands.length).toBe(before);
    expect(await dialog(page).getByRole("spinbutton").count()).toBe(0);
    expect(
      await dialog(page)
        .locator(".ai-map__state")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await dialog(page).getByRole("button", { name: "Berechnung fortsetzen", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ai-map__state"));
    expect(fixture.commands.slice(before)).toEqual([{ type: "retry" }]);
    expect(fixture.get(scenario).map.preview).toBeDefined();
    expect(fixture.get(scenario).map.issue).toBeUndefined();
  } finally {
    await context.close();
  }
});

test("ambiguous address recovery after an overrun explains further costs before accepting a candidate", async () => {
  const scenario = "route-overrun-ambiguous";
  const { page, context } = await open(scenario, 390);
  try {
    await openDialog(page);
    await dialog(page)
      .getByText("Die Route war teurer als geschätzt. Die Berechnung wurde gestoppt. Beim Fortsetzen können weitere Kosten entstehen.", {
        exact: true,
      })
      .waitFor();
    await dialog(page)
      .getByRole("button", { name: / · Als Stopp übernehmen$/, exact: false })
      .click();
    await dialog(page).getByRole("listbox", { name: "Welcher Ort ist gemeint?" }).waitFor({ state: "detached" });
    expect(fixture.get(scenario).map.issue).toBeUndefined();
    expect(fixture.get(scenario).map.route).toBeDefined();
  } finally {
    await context.close();
  }
});

describe.each([1440, 390])("route reservation address recovery at %i", (width) => {
  const name = `route-reservation-${width}`;
  let opened: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    const stored = fixture.get(name);
    delete stored.map.route;
    stored.map.plan = {
      stops: [
        { id: "a", address: { text: "Ulm" } },
        { id: "b", address: { text: "Blaubeuren" } },
        { id: "c", address: { text: "Stuttgart" } },
      ],
    };
    stored.map.issue = { code: "GEO_LIMIT_EXCEEDED", requiredCredits: 325, availableCredits: 300, shortfallCredits: 25 };
    opened = await open(name, width);
    await openDialog(opened.page);
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  const pick = async (mark: string) => {
    const { page } = opened;
    await dialog(page).getByRole("button", { name: "Stopp ändern", exact: true }).click();
    await dialog(page).getByRole("combobox", { name: "Stopp ändern", exact: true }).click();
    await page.getByRole("option", { name: new RegExp(`^${mark} ·`) }).click();
    const field = dialog(page).getByRole("combobox", { name: "Startort", exact: true });
    await field.fill("Beispielgasse");
    const index = mark.charCodeAt(0) - 65;
    const suggestion = page.getByRole("option", { name: new RegExp(`${index + 1} Beispielgasse`) });
    await suggestion.waitFor();
    await suggestion.click();
    expect(await field.inputValue()).toBe(mapAddress(index).formatted);
    return field;
  };
  test("editing a chosen suggestion clears its coordinates before retry", async () => {
    const { page } = opened;
    const field = await pick("C");
    await field.fill("Andere Adresse");
    await field.press("Escape");
    // Escape closes the suggestions; the map dialog stays open.
    await dialog(page).locator(".k2b-map-dialog").waitFor();
    const response = page.waitForResponse((r) => r.url().endsWith("/action") && r.request().method() === "POST");
    await dialog(page).getByRole("button", { name: "Vorschau berechnen", exact: true }).click();
    await response;
    expect(fixture.commands.at(-1)).toEqual({ type: "repair", stopId: "c", address: "Andere Adresse" });
    await dialog(page).getByRole("button", { name: "Stopp ändern", exact: true }).waitFor();
  });
  describe.each(["C", "B", "A"])("selected %s coordinates", (mark) => {
    test("survive refusal and final calculation", async () => {
      const { page } = opened;
      await pick(mark);
      const response = page.waitForResponse((r) => r.url().endsWith("/action") && r.request().method() === "POST");
      await dialog(page).getByRole("button", { name: "Vorschau berechnen", exact: true }).click();
      await response;
      const saved = fixture.get(name).map;
      expect(saved.plan?.stops.find((stop) => stop.id === mark.toLowerCase())?.point).toEqual(mapAddress(mark.charCodeAt(0) - 65).point);
      if (mark !== "A") {
        expect(saved.issue?.code).toBe("GEO_BUDGET_EXHAUSTED");
        await dialog(page).getByRole("button", { name: "Stopp ändern", exact: true }).waitFor();
      } else {
        expect(saved.issue).toBeUndefined();
        expect(saved.route?.stops.map((stop) => stop.id)).toEqual(["a", "b", "c"]);
        expect(saved.route?.stops.map((stop) => stop.point)).toEqual([0, 1, 2].map((index) => mapAddress(index).point));
        await dialog(page).getByRole("button", { name: "Weitere Aktionen", exact: true }).waitFor();
      }
    });
    if (mark !== "A")
      test("remain available after reload before choosing the next stop", async () => {
        await opened.page.reload();
        await dialog(opened.page).getByRole("button", { name: "Stopp ändern", exact: true }).waitFor();
        expect(fixture.get(name).map.plan?.stops.find((stop) => stop.id === mark.toLowerCase())?.point).toEqual(
          mapAddress(mark.charCodeAt(0) - 65).point,
        );
      });
  });
});
