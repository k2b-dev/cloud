import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { startMapBrowserFixture } from "../map-browser.test-fixture";
import type { AiMapCommand } from "../map-contracts";

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
test.each([1440, 390])(
  "insert search, selected stop, real delta, discard, accept and timestamped undo keep route dimensions at %i",
  async (width) => {
    const scenario = `route-insert-${width}`;
    const { page, context } = await open(scenario, width);
    try {
      const before = await dimensions(page);
      expect(before.height).toBe(width === 1440 ? 869 : 853);
      await page.getByRole("button", { name: "Stopp einfügen", exact: true }).click();
      await page.getByRole("button", { name: "Suchen", exact: true }).click();
      await page.getByRole("button", { name: /3\. Kleine Backstube/ }).click();
      await page.getByRole("button", { name: /Vorschau für Kleine Backstube/ }).click();
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
      await page.getByRole("button", { name: /3\. Kleine Backstube/ }).click();
      await page.getByRole("button", { name: /Vorschau für Kleine Backstube/ }).click();
      await page.getByRole("button", { name: "Kleine Backstube einfügen", exact: true }).click();
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
