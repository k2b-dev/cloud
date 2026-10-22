import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { mapPlaces } from "../map.test-fixture";
import { startMapBrowserFixture } from "../map-browser.test-fixture";
import type { AiMapCommand } from "../map-contracts";
import { aiMapNotebookContent } from "../map-notebook";

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
const dimensions = async (page: Page) =>
  page.locator(".ai-map").evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { top: b.top, height: b.height, width: b.width };
  });
test("places use numbered pins, keyboard/list/map selection and unknown hours", async () => {
  fixture.get("places-keyboard").map.groups[0]!.places[5]!.website = "https://[";
  const { page, context } = await open("places-keyboard");
  const errors = pageErrors(page);
  try {
    expect(await page.locator(".ai-map__place").count()).toBe(6);
    const list = page.getByRole("listbox", { name: "Orte" });
    await list.focus();
    await page.keyboard.press("End");
    await page.getByText("◷ Öffnungszeiten unbekannt", { exact: true }).waitFor();
    await page.keyboard.press("Home");
    expect(await page.locator(".ai-map__place").first().getAttribute("aria-selected")).toBe("true");
    expect(await page.locator(".ai-map__info").innerText()).toContain("heute 10:00–17:00 Uhr");
    await page.locator('[data-id="museum-2"]').click();
    expect(await page.locator(".ai-map__place").nth(2).getAttribute("aria-selected")).toBe("true");
    expect(errors).toEqual([]);
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
  test("retains original map, conversation and measured dimensions through reload", async () => {
    const { page } = opened;
    const before = await dimensions(page);
    expect(before.height).toBe(width === 1440 ? 811 : 960);
    await page.evaluate(() =>
      window.mapFollowup({ type: "search", search: { title: "Cafés", categories: ["cafe"], placeId: "museum-0" } }),
    );
    await page.getByRole("link", { name: /Zur Karte/ }).waitFor();
    await settled(page);
    expect(await page.locator(".ai-map").count()).toBe(1);
    expect(await dimensions(page)).toEqual(before);
    expect(await page.locator(".ai-map__place[data-second=true]").count()).toBe(4);
    expect(await page.locator("body").innerText()).toContain("Deine bisherigen Antworten bleiben erhalten");
    await page.reload();
    await page.locator(".ai-map__place[data-second=true]").first().waitFor();
    await settled(page);
    expect(await dimensions(page)).toEqual(before);
    if (width === 390) {
      expect(await page.locator(".ai-map__list").evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
      await page.getByRole("button", { name: "Alle 10 Orte" }).click();
      expect(await page.locator(".ai-map__place:visible").count()).toBe(10);
    }
  });
});
test.each([1440, 390])("named place search submits the provider name, fits all results and restores after reload at %i", async (width) => {
  const scenario = `route-name-${width}`;
  const { page, context } = await open(scenario, width);
  try {
    const before = await dimensions(page);
    expect(before.height).toBe(width === 1440 ? 869 : 853);
    await page.getByRole("button", { name: "Stopp einfügen", exact: true }).click();
    await page.getByLabel("Ortsname (optional)", { exact: true }).fill(" Wasserfall ");
    await settled(page);
    expect(await dimensions(page)).toEqual(before);
    if (process.env.PLACE_NAME_EVIDENCE_DIR)
      await page.screenshot({ path: `${process.env.PLACE_NAME_EVIDENCE_DIR}/route-name-form-light-${width}.png`, fullPage: true });
    await page.getByRole("button", { name: "Suchen", exact: true }).click();
    await page.getByRole("button", { name: /3\. Fiktiver Wasserfall 3/ }).click();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "search",
      insert: true,
      search: { name: "Wasserfall", categories: ["attraction"], along: { fromKm: 0, toKm: 162 } },
    });
    expect(fixture.get(scenario).map.lastSearch?.name).toBe("Wasserfall");
    expect(fixture.placeSearches.at(-1)).toMatchObject({ name: "Wasserfall", categories: ["attraction"], limit: 5 });
    await settled(page);
    expect(await dimensions(page)).toEqual(before);
    const stages = await page.locator(".ai-map__stages").boundingBox();
    const lastChoice = await page.getByRole("button", { name: /5\. Fiktiver Wasserfall 5/ }).boundingBox();
    expect(lastChoice!.y + lastChoice!.height).toBeLessThanOrEqual(stages!.y + stages!.height);
    if (process.env.PLACE_NAME_EVIDENCE_DIR)
      await page.screenshot({ path: `${process.env.PLACE_NAME_EVIDENCE_DIR}/route-name-results-light-${width}.png`, fullPage: true });
    await page.reload();
    await page.getByRole("button", { name: "Stopp einfügen", exact: true }).click();
    expect(await page.getByLabel("Ortsname (optional)", { exact: true }).inputValue()).toBe("Wasserfall");
    await page.getByRole("button", { name: /3\. Fiktiver Wasserfall 3/ }).click();
  } finally {
    await context.close();
  }
});
test.each([1440, 390])(
  "insert search, selected stop, real delta, discard, accept and timestamped undo keep route dimensions at %i",
  async (width) => {
    const scenario = `route-insert-${width}`;
    const { page, context } = await open(scenario, width);
    try {
      const before = await dimensions(page);
      expect(before.height).toBe(width === 1440 ? 869 : 853);
      await page.getByRole("button", { name: "Stopp einfügen", exact: true }).click();
      await page.getByLabel("Ortsname (optional)", { exact: true }).fill("Wasserfall");
      await page.getByRole("button", { name: "Suchen", exact: true }).click();
      await page.getByRole("button", { name: /3\. Fiktiver Wasserfall 3/ }).click();
      await page.getByRole("button", { name: /Vorschau für Fiktiver Wasserfall 3/ }).click();
      await page.getByRole("button", { name: "Verwerfen", exact: true }).waitFor();
      await settled(page);
      expect(await page.locator(".ai-map__facts").innerText()).toContain("+12 min");
      expect(await page.locator(".ai-map__facts").innerText()).toContain("+4 km");
      expect(await dimensions(page)).toEqual(before);
      expect(fixture.get(scenario).map.route?.stops).toHaveLength(4);
      await page.getByRole("button", { name: "Verwerfen", exact: true }).click();
      await page.getByRole("button", { name: "Stopp einfügen", exact: true }).waitFor();
      await page.getByRole("button", { name: "Stopp einfügen", exact: true }).click();
      await page.getByRole("button", { name: "Suchen", exact: true }).click();
      await page.getByRole("button", { name: /3\. Fiktiver Wasserfall 3/ }).click();
      await page.getByRole("button", { name: /Vorschau für Fiktiver Wasserfall 3/ }).click();
      await page.getByRole("button", { name: "Fiktiver Wasserfall 3 einfügen", exact: true }).click();
      await page.getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
      expect(fixture.get(scenario).map.route?.stops).toHaveLength(5);
      await settled(page);
      expect(await dimensions(page)).toEqual(before);
      expect(await page.locator(".ai-map__receipt time").getAttribute("datetime")).toBe("2026-10-19T14:31:00.000Z");
      await page.getByRole("button", { name: "Rückgängig", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".ai-map__receipt button"));
      expect(fixture.get(scenario).map.route?.stops).toHaveLength(4);
      await settled(page);
      expect(await dimensions(page)).toEqual(before);
    } finally {
      await context.close();
    }
  },
);
test("ambiguity calculates only after choosing server candidate; options preserve scope", async () => {
  const { page, context } = await open("route-ambiguous");
  try {
    const calls = fixture.geo.calls.length;
    await page.getByRole("option", { name: /2\. 2 Beispielgasse/ }).click();
    expect(fixture.geo.calls.length).toBe(calls);
    await page.getByRole("button", { name: /2 Beispielgasse.*Als Stopp übernehmen/ }).click();
    await page.getByRole("button", { name: "Optionen", exact: true }).waitFor();
    expect(fixture.geo.calls.slice(calls)).toContain("calculate");
    await page.getByRole("button", { name: "Optionen", exact: true }).click();
    await page.getByLabel("Autobahn", { exact: true }).click();
    await page.getByRole("button", { name: "Vorschau berechnen" }).click();
    await page.getByRole("button", { name: "Verwerfen", exact: true }).waitFor();
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
    expect(await page.locator("body").innerText()).toContain("Orte und Karten sind nicht eingerichtet");
    expect(await page.locator(".k2b-map-view").count()).toBe(0);
    expect(fixture.calls.slice(start)).toEqual([]);
    expect(await page.getByRole("link", { name: "Orte und Karten einrichten" }).count()).toBe(0);
  } finally {
    await context.close();
  }
});
test.each(["person", "cloud"])("budget %s shows reset and retained source list", async (scope) => {
  const { page, context } = await open(`places-budget-${scope}`);
  try {
    expect(await page.locator("body").innerText()).toContain(scope === "person" ? "Tagesgrenze" : "Monatsbudget");
    expect(await page.locator("body").innerText()).toContain("Wieder verfügbar");
    expect(await page.locator(".k2b-map-view").count()).toBe(0);
  } finally {
    await context.close();
  }
});
test("empty search expands original query, failure retries, dark/tablet and compact panel reserve their regions", async () => {
  const { page, context } = await open("places-empty", 768, "&theme=dark");
  try {
    await page.getByRole("button", { name: "Umkreis 10 km" }).click();
    await page.locator(".ai-map__place").first().waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({ type: "search", search: { categories: ["museum"], near: "Ulm", radiusMeters: 10000 } });
    await page.goto(`${fixture.server.url}?scenario=places-failure&panel=true&theme=dark`);
    await page.getByRole("button", { name: "Erneut versuchen" }).click();
    await page.locator(".ai-map__place").first().waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await settled(page);
    expect(await page.locator(".k2b-map-view").evaluate((el) => el.getBoundingClientRect().height)).toBe(200);
    expect(await page.locator(".ai-map__info").evaluate((el) => el.getBoundingClientRect().height)).toBe(228);
  } finally {
    await context.close();
  }
});

test.each([1440, 390, 768])("SSR and first browser render reserve the same map and information regions at %i", async (width) => {
  const { page, context } = await open(`places-ssr-${width}`, width, "&ssr=1");
  try {
    const server = await dimensions(page);
    const card = await page.locator(".ai-map__info").boundingBox();
    await page.goto(`${fixture.server.url}?scenario=places-ssr-${width}`);
    await page.locator(".ai-map__place").first().waitFor();
    await settled(page);
    expect(await dimensions(page)).toEqual(server);
    expect(await page.locator(".ai-map__info").boundingBox()).toEqual(card);
  } finally {
    await context.close();
  }
});

test("location denial keeps dimensions and offers address route recovery", async () => {
  const { page, context } = await open("places-location");
  try {
    const before = await dimensions(page);
    await page.evaluate(() =>
      Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
        configurable: true,
        value: (_ok: unknown, fail: (error: unknown) => void) => fail({ code: 1, PERMISSION_DENIED: 1 }),
      }),
    );
    await page.getByRole("button", { name: "Ich bin hier", exact: true }).click();
    await page.getByText("Standort nicht erlaubt · im Browser freigeben", { exact: true }).waitFor();
    await settled(page);
    expect(await dimensions(page)).toEqual(before);
    await page.getByRole("button", { name: "Route hierher", exact: true }).click();
    await page.getByLabel("Startort", { exact: true }).fill("Fiktiver Hauptbahnhof");
    await page.getByRole("button", { name: "Route planen", exact: true }).click();
    await page.getByRole("button", { name: "Stopp einfügen", exact: true }).waitFor();
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
    await page.getByRole("button", { name: "Ich bin hier", exact: true }).click();
    await page.locator(".k2b-map-view__me").waitFor();
    await page.getByRole("button", { name: "Route hierher", exact: true }).click();
    await page.getByRole("button", { name: "Stopp einfügen", exact: true }).waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "location",
      destinationId: "museum-0",
      point: { lat: 48.4, lon: 10 },
    });
  } finally {
    await context.close();
  }
});

test("whole and per-leg preferences calculate a real preview and retain the leg label after accept", async () => {
  const { page, context } = await open("route-per-leg");
  try {
    await page.getByRole("button", { name: "Optionen", exact: true }).click();
    await page.getByRole("combobox", { name: "Gilt für", exact: true }).click();
    await page.getByRole("option", { name: "B → C", exact: true }).click();
    await page.getByLabel("Autobahn", { exact: true }).click();
    await page.getByRole("button", { name: "Vorschau berechnen", exact: true }).click();
    await page.getByRole("button", { name: "Etappe ohne Autobahn", exact: true }).waitFor();
    expect(fixture.commands.at(-1)).toMatchObject({
      type: "preview",
      change: { type: "options", leg: { fromStopId: "stop-1", toStopId: "stop-2" } },
    });
    await page.getByRole("button", { name: "Etappe ohne Autobahn", exact: true }).click();
    await page.getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
    expect(await page.locator(".ai-map__leg").nth(1).innerText()).toContain("ohne Autobahn");
    expect(await page.locator(".ai-map__leg").first().innerText()).not.toContain("ohne Autobahn");
  } finally {
    await context.close();
  }
});

test("optimize and move keep old letters until accept and render both stop orders", async () => {
  const { page, context } = await open("route-optimize");
  try {
    await page.getByRole("button", { name: "Reihenfolge optimieren", exact: true }).click();
    await page.getByRole("button", { name: "Neue Reihenfolge übernehmen", exact: true }).waitFor();
    expect(await page.locator(".ai-map__facts [data-gain=true]").innerText()).toContain("-12 min");
    expect(await page.locator(".ai-map__order li").allTextContents()).toEqual([
      "Ulm",
      "Bad Urach",
      "Blautopf",
      "Stuttgart",
      "Ulm",
      "Blautopf",
      "Bad Urach",
      "Stuttgart",
    ]);
    expect(await page.locator('[data-id="stop-1"]').innerText()).toBe("B");
    await page.getByRole("button", { name: "Neue Reihenfolge übernehmen", exact: true }).click();
    await page.getByRole("button", { name: "Rückgängig", exact: true }).waitFor();
    expect(await page.locator('[data-id="stop-1"]').innerText()).toBe("C");
    await page.evaluate(() => window.mapFollowup({ type: "preview", change: { type: "move", stopId: "stop-1", toIndex: 1 } }));
    await page.getByRole("button", { name: "Stopp verschieben", exact: true }).waitFor();
    expect(fixture.get("route-optimize").map.route?.stops[1]?.id).toBe("stop-2");
    await page.getByRole("button", { name: "Stopp verschieben", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".ai-map__confirm"));
    expect(fixture.get("route-optimize").map.route?.stops[1]?.id).toBe("stop-1");
  } finally {
    await context.close();
  }
});

test("along-route window reaches server search and navigation link retains destination", async () => {
  const { page, context } = await open("route-along");
  try {
    await page.getByRole("button", { name: "Unterwegs essen", exact: true }).click();
    await page.getByRole("button", { name: "Suchen", exact: true }).click();
    await page.locator(".ai-map__route-place").waitFor();
    expect(await page.getByRole("button", { name: /km 44/ }).innerText()).toContain("0,3 km");
    expect(fixture.get("route-along").map.groups).toHaveLength(1);
    expect(fixture.commands.at(-1)).toMatchObject({ type: "search", search: { along: { fromKm: 40, toKm: 80 } } });
    expect(await page.getByRole("link", { name: "In Navi-App öffnen", exact: true }).getAttribute("href")).toContain("openstreetmap.org");
    expect(await page.locator(".ai-map__provenance").innerText()).toContain("Zeiten ohne Verkehr");
  } finally {
    await context.close();
  }
});

test.each(["save", "unknown-save"])("Notebook %s uses shared Markdown, stable idempotency and reload-safe outcome", async (suffix) => {
  const { page, context } = await open(`places-${suffix}`);
  try {
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByRole("combobox", { name: "Notebook auswählen", exact: true }).click();
    await page.getByRole("option", { name: "Fiktive Reiseplanung", exact: true }).click();
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByRole("link", { name: suffix === "save" ? "Im Notebook gespeichert" : "Notebook prüfen", exact: true }).waitFor();
    expect(JSON.stringify(fixture.commands.at(-1))).toContain(":::map");
    await page.reload();
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByRole("link", { name: suffix === "save" ? "Im Notebook gespeichert" : "Notebook prüfen", exact: true }).waitFor();
    if (suffix !== "save") expect(await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).isDisabled()).toBe(true);
  } finally {
    await context.close();
  }
});

test.each(["places", "route"])("loading %s retains ready dimensions without replacing the conversation", async (kind) => {
  const { page, context } = await open(`${kind}-loading`);
  try {
    expect(await page.locator(".ai-map__skeleton").count()).toBeGreaterThan(0);
    expect((await dimensions(page)).height).toBe(kind === "places" ? 811 : 869);
  } finally {
    await context.close();
  }
});

test("retry in an unconfigured map never calls a provider; configuration links require administrator state", async () => {
  const { page, context } = await open("places-unconfigured-admin");
  try {
    await page.getByRole("link", { name: "Orte und Karten einrichten", exact: true }).waitFor();
    const before = fixture.geo.calls.length;
    await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".ai-map")?.getAttribute("aria-busy") === "false");
    expect(fixture.geo.calls.slice(before)).toEqual(["availability"]);
    expect(await page.locator(".k2b-map-view").count()).toBe(0);
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
    await page.getByRole("button", { name: "Reihenfolge optimieren", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Diese Karte wurde inzwischen geändert" }).waitFor();
    expect(fixture.geo.calls.length).toBe(before);
    await page.getByRole("button", { name: "Aktuellen Stand laden", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
    expect(fixture.geo.calls.length).toBe(before);
  } finally {
    await context.close();
  }
});

// These tests run the actual save component and helper against the public capability HTTP seam.
const chooseNotebook = async (page: Page) => {
  await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
  await page.getByRole("combobox", { name: "Notebook auswählen", exact: true }).click();
  await page.getByRole("option", { name: "Fiktive Reiseplanung", exact: true }).click();
};
const beginSave = async (page: Page) => {
  await chooseNotebook(page);
  await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
};
const reopenSave = async (page: Page) => {
  await page.reload();
  await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
};
const largeSource = (scenario: string) => {
  const map = fixture.get(scenario).map;
  map.title = "Café 🗺️ 東京 — vollständige Route";
  map.groups = [
    { title: "Museen", places: mapPlaces(20) },
    { title: "Cafés 東京", places: mapPlaces(20, "cafe") },
  ];
  map.route!.polyline6 = "??".repeat(30_000);
  for (const leg of map.route!.legs) leg.polyline6 = "??".repeat(30_000);
  return aiMapNotebookContent(map);
};

test.each([390, 1440])("large exact save reports confirmed progress, cancels, resumes and retains its receipt at %i", async (width) => {
  const scenario = `route-chunked-save-${width}`;
  const expected = largeSource(scenario);
  const { page, context } = await open(scenario, width, width === 390 ? "&theme=dark" : "");
  const writes: { path: string; bytes: number; checkpoint: unknown }[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await page.route("**/actions/notebooks/*", async (route) => {
    const request = route.request();
    const checkpoint = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("cloud.ai.map-save:v1:")));
    writes.push({ path: request.url(), bytes: new TextEncoder().encode(request.postData()!).byteLength, checkpoint });
    if (request.url().endsWith("note.edit") && writes.length === 2) {
      entered();
      await held;
      await route.abort(); // Nothing was sent; the browser still cannot assume that after cancellation.
    } else await route.continue();
  });
  try {
    await beginSave(page);
    await dispatched;
    expect(await page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(String(Math.round((200_000 / expected.length) * 100)));
    await page.getByRole("link", { name: "Teilweise gespeicherte Notiz öffnen" }).waitFor();
    await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
    release();
    await page.getByRole("button", { name: "Speicherstand prüfen", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".ai-map__save .ai-map__actions button")?.disabled);
    expect(fixture.notes.get(scenario)).toBe(expected.slice(0, 200_000));
    // A pending append at the before-hash must never be resent, even on explicit resume.
    await page.getByRole("button", { name: "Speicherstand prüfen", exact: true }).click();
    await page.getByText(/Der letzte Teil wird möglicherweise noch gespeichert/).waitFor();
    expect(writes).toHaveLength(2);
    // Simulate the uncertain original append becoming visible later, with its exact after-hash.
    fixture.notes.set(scenario, expected);
    await reopenSave(page);
    await page.getByRole("button", { name: "Speicherstand prüfen", exact: true }).click();
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(fixture.notes.get(scenario)).toBe(expected);
    expect(writes).toHaveLength(2);
    expect(writes.every((write) => write.bytes <= 256 * 1024)).toBe(true);
    expect(JSON.stringify(writes[0]!.checkpoint)).toContain("create");
    expect(JSON.stringify(writes[1]!.checkpoint)).toContain("append");
    expect(await page.locator(".ai-map__save").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally {
    release();
    await context.close();
  }
});

test("large source saves through real create, read and exact append receipts", async () => {
  const scenario = "route-large-save-complete";
  const expected = largeSource(scenario);
  const { page, context } = await open(scenario);
  try {
    const start = fixture.commands.length;
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(fixture.notes.get(scenario)).toBe(expected);
    const mutations = fixture.commands.length - start;
    await reopenSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(fixture.commands.length - start).toBe(mutations);
    expect(await page.getByRole("link", { name: "Im Notebook gespeichert" }).getAttribute("href")).toBe("/open/notebooks.note/~Note01");
  } finally {
    await context.close();
  }
});

test("save storage rejection is visible and prevents create; explicit recovery can save", async () => {
  const { page, context } = await open("places-storage-save");
  try {
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Full", "QuotaExceededError");
      };
    });
    const start = fixture.commands.length;
    await beginSave(page);
    await page.getByText(/Der Fortschritt konnte in diesem Browser nicht gespeichert werden/).waitFor();
    expect(fixture.commands.length).toBe(start);
    await reopenSave(page); // Restores working browser storage and starts a known-unsent save.
    await page.getByRole("combobox", { name: "Notebook auswählen", exact: true }).click();
    await page.getByRole("option", { name: "Fiktive Reiseplanung", exact: true }).click();
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

test("same-source saves in two tabs take one browser lock and reuse the completed checkpoint", async () => {
  const scenario = "places-two-tabs-save";
  const { page, context } = await open(scenario);
  const second = await context.newPage();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let creates = 0;
  await context.route("**/actions/notebooks/note.create", async (route) => {
    creates++;
    entered();
    await held;
    await route.continue();
  });
  try {
    await second.goto(page.url());
    await chooseNotebook(second);
    await beginSave(page);
    await dispatched;
    await second.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await second.getByText(/Diese Karte wird in einem anderen Tab gespeichert/).waitFor();
    expect(creates).toBe(1);
    release();
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    await second.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await second.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(creates).toBe(1);
  } finally {
    release();
    await context.close();
  }
});

test.each(["storage", "locks"])("unavailable %s fails visibly before any save mutation", async (unavailable) => {
  const { page, context } = await open(`places-unavailable-${unavailable}`);
  try {
    await page.evaluate((value) => {
      if (value === "locks") Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
      else
        Storage.prototype.getItem = () => {
          throw new DOMException("Denied", "SecurityError");
        };
    }, unavailable);
    const start = fixture.commands.length;
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").innerText()).toContain(unavailable === "locks" ? "Web-Locks" : "lokalen Speicher");
    expect(fixture.commands.length).toBe(start);
    await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
    expect(await page.locator(".ai-map__save").count()).toBe(0);
  } finally {
    await context.close();
  }
});

test("known partial note resumes after cancellation and a refreshed opening-hours clock", async () => {
  const scenario = "route-known-partial-save";
  const expected = largeSource(scenario);
  const { page, context } = await open(scenario);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  await page.route("**/queries/notebooks/note.read", async (route) => {
    if (first) {
      first = false;
      entered();
      await held;
      await route.abort();
    } else await route.continue();
  });
  try {
    await beginSave(page);
    await dispatched;
    await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
    release();
    await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).waitFor();
    expect(await page.getByRole("alert").innerText()).toContain("Speichern gestoppt");
    expect(fixture.notes.get(scenario)).toBe(expected.slice(0, 200_000));
    fixture.get(scenario).map.viewedAt = "2026-10-23T01:00:00.000Z";
    await reopenSave(page);
    await page.getByRole("link", { name: "Teilweise gespeicherte Notiz öffnen" }).waitFor();
    expect(await page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(String(Math.round((200_000 / expected.length) * 100)));
    await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).click();
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(fixture.notes.get(scenario)).toBe(expected);
  } finally {
    release();
    await context.close();
  }
});

test.each(["source", "note"])("changed %s blocks partial save with a known recovery link", async (changed) => {
  const scenario = `route-conflict-save-${changed}`;
  largeSource(scenario);
  const { page, context } = await open(scenario);
  await page.route("**/actions/notebooks/note.edit", async (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ code: "NOT_ALLOWED", message: "Not allowed to edit this note." }),
    }),
  );
  try {
    await beginSave(page);
    await page.getByText("Not allowed to edit this note.", { exact: true }).waitFor();
    if (changed === "source") fixture.get(scenario).map.title = "Changed at the same revision";
    else fixture.notes.set(scenario, `${fixture.notes.get(scenario)}\nExternal edit`);
    await page.unroute("**/actions/notebooks/note.edit");
    await reopenSave(page);
    await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).click();
    await page.getByText(changed === "source" ? /Die Kartenquelle hat sich geändert/ : /Die Notiz hat sich geändert/).waitFor();
    await page.getByRole("link", { name: "Teilweise gespeicherte Notiz öffnen" }).waitFor();
    expect(await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).isDisabled()).toBe(true);
  } finally {
    await context.close();
  }
});

test("unknown create remains blocked beyond claim retention and exposes Notebook recovery", async () => {
  const { page, context } = await open("places-unknown-save-retained");
  let creates = 0;
  await page.route("**/actions/notebooks/note.create", async (route) => {
    creates++;
    await route.continue();
  });
  try {
    await beginSave(page);
    await page.getByText(/Die Notiz wurde möglicherweise erstellt/).waitFor();
    await page.clock.install({ time: new Date("2026-10-22T12:00:00.000Z") });
    await page.clock.fastForward(25 * 60 * 60 * 1000);
    await reopenSave(page);
    await page.getByRole("link", { name: "Notebook prüfen", exact: true }).waitFor();
    expect(await page.getByRole("link", { name: "Notebook prüfen", exact: true }).getAttribute("href")).toBe(
      "/open/notebooks.notebook/~Book01",
    );
    expect(await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).isDisabled()).toBe(true);
    expect(creates).toBe(1);
  } finally {
    await context.close();
  }
});

test("owner, conversation and revision isolate retained checkpoints", async () => {
  const scenario = "places-owner-isolation";
  const { page, context } = await open(scenario);
  let ownerUserId = "owner-one";
  let creates = 0;
  await page.route("**/export", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ownerUserId } });
  });
  await page.route("**/actions/notebooks/note.create", async (route) => {
    creates++;
    await route.continue();
  });
  try {
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    ownerUserId = "owner-two";
    await page.reload();
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    fixture.get(scenario).map.revision++;
    await page.reload();
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    await page.goto(`${fixture.server.url}?scenario=places-other-conversation`);
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("cloud.ai.map-save:v1:")));
    expect(keys).toHaveLength(4);
    expect(keys.some((key) => key.includes("owner-one"))).toBe(true);
    expect(keys.filter((key) => key.includes("owner-two"))).toHaveLength(3);
    expect(creates).toBe(4);
  } finally {
    await context.close();
  }
});

test("a signed-in owner change between selection and save cannot reuse the previous owner's receipt", async () => {
  const { page, context } = await open("places-owner-changed");
  let requests = 0;
  await page.route("**/export", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), ownerUserId: ++requests === 1 ? "owner-one" : "owner-two" } });
  });
  try {
    const start = fixture.commands.length;
    await beginSave(page);
    await page.getByText(/Das angemeldete Konto hat sich geändert/).waitFor();
    expect(fixture.commands.length).toBe(start);
  } finally {
    await context.close();
  }
});

test("persistence failure after a create keeps its known note and safely resumes without creating twice", async () => {
  const scenario = "route-receipt-storage-recovery";
  const expected = largeSource(scenario);
  const { page, context } = await open(scenario);
  let creates = 0;
  await page.route("**/actions/notebooks/note.create", async (route) => {
    creates++;
    await route.continue();
  });
  try {
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      let failed = false;
      Storage.prototype.setItem = function (key, value) {
        original.call(this, key, value);
        if (!key.startsWith("cloud.ai.map-save:v1:")) return;
        const stored = JSON.parse(value);
        if (!failed && stored.checkpoint?.noteId) {
          failed = true;
          throw new DOMException("Full", "QuotaExceededError");
        }
      };
    });
    await beginSave(page);
    await page.getByText(/Der Fortschritt konnte in diesem Browser nicht gespeichert werden/).waitFor();
    await page.getByRole("link", { name: "Teilweise gespeicherte Notiz öffnen" }).waitFor();
    expect(creates).toBe(1);
    await reopenSave(page);
    await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).click();
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(fixture.notes.get(scenario)).toBe(expected);
    expect(creates).toBe(1);
  } finally {
    await context.close();
  }
});

test.each(["pending", "unknown", "saved"])("legacy %s receipt cannot silently create another note", async (status) => {
  const scenario = `places-legacy-${status}`;
  const { page, context } = await open(scenario);
  try {
    await page.evaluate(
      ({ status, map }) =>
        sessionStorage.setItem(`cloud.ai.map-save:${map.id}:${map.revision}`, JSON.stringify({ status, notebookId: "Book01" })),
      { status, map: fixture.get(scenario).map },
    );
    const start = fixture.commands.length;
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByText(/Für diese Karte liegt ein früherer Speicherbeleg vor/).waitFor();
    await page.getByRole("link", { name: "Notebook prüfen", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).isDisabled()).toBe(true);
    expect(fixture.commands.length).toBe(start);
  } finally {
    await context.close();
  }
});

test("a storage-failed tab adopts a newer completed receipt without replacing it", async () => {
  const scenario = "places-failed-tab-newer-receipt";
  const { page, context } = await open(scenario);
  const second = await context.newPage();
  let creates = 0;
  await context.route("**/actions/notebooks/note.create", async (route) => {
    creates++;
    await route.continue();
  });
  try {
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Full", "QuotaExceededError");
      };
    });
    await beginSave(page);
    await page.getByText(/Der Fortschritt konnte in diesem Browser nicht gespeichert werden/).waitFor();
    expect(creates).toBe(0);
    await second.goto(page.url());
    await beginSave(second);
    await second.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    const receipt = await second.evaluate(() => Object.entries(localStorage));
    await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).click();
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(receipt);
    expect(creates).toBe(1);
  } finally {
    await context.close();
  }
});

test("corrupt stored progress fails visibly instead of starting a fresh save", async () => {
  const scenario = "places-corrupt-save";
  const { page, context } = await open(scenario, 1440, "&lang=en");
  try {
    await page.evaluate((map) => {
      const source = JSON.stringify(["fictional-owner", map.conversationId, map.id, map.revision]);
      localStorage.setItem(`cloud.ai.map-save:v1:${source}`, '{"checkpoint":{"version":1}}');
    }, fixture.get(scenario).map);
    const start = fixture.commands.length;
    await page.getByRole("button", { name: "Save as Notebook", exact: true }).click();
    await page.getByText(/Save progress could not be stored in this browser/).waitFor();
    expect(await page.getByRole("button", { name: "Try again", exact: true }).isEnabled()).toBe(true);
    expect(fixture.commands.length).toBe(start);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.locator(".ai-map__save").count()).toBe(0);
  } finally {
    await context.close();
  }
});

test("an invalid export response leaves a calm localized error and a working retry", async () => {
  const { page, context } = await open("places-invalid-export");
  await page.route("**/export", async (route) => route.fulfill({ contentType: "application/json", body: "invalid JSON" }));
  try {
    const start = fixture.commands.length;
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByText(/Die Karte konnte nicht gespeichert werden/).waitFor();
    expect(fixture.commands.length).toBe(start);
    await page.unroute("**/export");
    await page.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await page.getByRole("combobox", { name: "Notebook auswählen", exact: true }).click();
    await page.getByRole("option", { name: "Fiktive Reiseplanung", exact: true }).click();
    await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

test("a follow-up cannot display an old receipt as saving the new map revision", async () => {
  const scenario = "places-save-revision-followup";
  const { page, context } = await open(scenario);
  try {
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    await page.evaluate(() =>
      window.mapFollowup({ type: "search", search: { title: "Cafés", categories: ["cafe"], placeId: "museum-0" } }),
    );
    await page.getByText(/Die Kartenquelle hat sich geändert/).waitFor();
    expect(await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).count()).toBe(0);
    await page.getByRole("link", { name: "Teilweise gespeicherte Notiz öffnen" }).waitFor();
    await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("cloud.ai.map-save:v1:")).length)).toBe(2);
  } finally {
    await context.close();
  }
});

test("identical initial checkpoints from different tabs cannot revive a known-unsent create", async () => {
  const scenario = "places-identical-pending-receipts";
  const { page, context } = await open(scenario);
  const second = await context.newPage();
  let creates = 0;
  await context.route("**/actions/notebooks/note.create", async (route) => {
    creates++;
    await route.fetch(); // The note exists, but its identity/receipt is lost.
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", message: "Outcome unclear" }),
    });
  });
  try {
    await page.evaluate(() => {
      const get = Storage.prototype.getItem,
        set = Storage.prototype.setItem;
      let blockRead = false;
      Storage.prototype.getItem = function (key) {
        if (blockRead && key.startsWith("cloud.ai.map-save:v1:")) throw new DOMException("Denied", "SecurityError");
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("cloud.ai.map-save:v1:")) {
          blockRead = true;
          throw new DOMException("Full", "QuotaExceededError");
        }
        set.call(this, key, value);
      };
      document.addEventListener("recover-map-save-storage", () => {
        Storage.prototype.getItem = get;
        Storage.prototype.setItem = set;
      });
    });
    await beginSave(page);
    await page.getByText(/Der Fortschritt konnte in diesem Browser nicht gespeichert werden/).waitFor();
    expect(creates).toBe(0);
    await second.goto(page.url());
    await settled(second);
    await second.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith("cloud.ai.map-save:v1:") && JSON.parse(value).status !== "paused")
          throw new DOMException("Full", "QuotaExceededError");
        set.call(this, key, value);
      };
    });
    await beginSave(second);
    await second.getByText(/Der Fortschritt konnte in diesem Browser nicht gespeichert werden/).waitFor();
    const receipt = await second.evaluate(() => Object.entries(localStorage));
    await page.evaluate(() => document.dispatchEvent(new Event("recover-map-save-storage")));
    await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).click();
    await page.getByText(/Die Notiz wurde möglicherweise erstellt/).waitFor();
    expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(receipt);
    expect(await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).isDisabled()).toBe(true);
    expect(creates).toBe(1);
  } finally {
    await context.close();
  }
});
