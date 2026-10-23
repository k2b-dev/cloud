import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { mapAddress } from "../map.test-fixture";
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
describe.each(["/app/assistant", "/app/assistant/panel"])("older map navigation from %s", (path) => {
  test.each([1440, 390])("keeps the host route when loading history at %i", async (width) => {
    const scenario = `places-jump-${path.endsWith("panel") ? "panel" : "full"}-${width}`;
    const { page, context } = await open(scenario, width);
    const errors = pageErrors(page);
    try {
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
    } finally {
      await context.close();
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

const chooseNotebook = async (page: Page) => {
  await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
  await page.getByRole("combobox", { name: "Notebook auswählen", exact: true }).click();
  await page.getByRole("option", { name: "Fiktive Reiseplanung", exact: true }).click();
};
const beginSave = async (page: Page) => {
  await chooseNotebook(page);
  await page.getByRole("button", { name: "Als Notebook speichern", exact: true }).click();
};
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

test.each([390, 1440])("routing overrun shows charged costs and waits for an explicit resume at %i", async (width) => {
  const scenario = `route-overrun-${width}`;
  const before = fixture.commands.length;
  const { page, context } = await open(scenario, width);
  try {
    await page.getByText("Letzter Versuch: 20 Credits gebucht. Mit unklarem Ergebnis reserviert: 2.", { exact: true }).waitFor();
    expect(fixture.commands.length).toBe(before);
    expect(await page.getByRole("spinbutton").count()).toBe(0);
    expect(await page.locator(".ai-map__state").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "Berechnung fortsetzen", exact: true }).click();
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
    await page
      .getByText("Die Route war teurer als geschätzt. Die Berechnung wurde gestoppt. Beim Fortsetzen können weitere Kosten entstehen.", {
        exact: true,
      })
      .waitFor();
    await page.getByRole("button", { name: / · Als Stopp übernehmen$/, exact: false }).click();
    await page.getByRole("listbox", { name: "Welcher Ort ist gemeint?" }).waitFor({ state: "detached" });
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
    if (process.env.MAP_RECOVERY_EVIDENCE_DIR)
      await opened.page.screenshot({ path: `${process.env.MAP_RECOVERY_EVIDENCE_DIR}/01-reservation-light-${width}.png`, fullPage: true });
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  const pick = async (mark: string) => {
    const { page } = opened;
    await page.getByRole("button", { name: "Stopp ändern", exact: true }).click();
    await page.getByRole("combobox", { name: "Stopp ändern", exact: true }).click();
    await page.getByRole("option", { name: new RegExp(`^${mark} ·`) }).click();
    const field = page.getByRole("combobox", { name: "Startort", exact: true });
    await field.fill("Beispielgasse");
    const index = mark.charCodeAt(0) - 65;
    const suggestion = page.getByRole("option", { name: new RegExp(`${index + 1} Beispielgasse`) });
    await suggestion.waitFor();
    if (mark === "C" && process.env.MAP_RECOVERY_EVIDENCE_DIR)
      await page.screenshot({ path: `${process.env.MAP_RECOVERY_EVIDENCE_DIR}/02-suggestions-light-${width}.png`, fullPage: true });
    await suggestion.click();
    expect(await field.inputValue()).toBe(mapAddress(index).formatted);
    return field;
  };
  test("editing a chosen suggestion clears its coordinates before retry", async () => {
    const { page } = opened;
    const field = await pick("C");
    await field.fill("Andere Adresse");
    await field.press("Escape");
    const response = page.waitForResponse((r) => r.url().endsWith("/action") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Vorschau berechnen", exact: true }).click();
    await response;
    expect(fixture.commands.at(-1)).toEqual({ type: "repair", stopId: "c", address: "Andere Adresse" });
    await page.getByRole("button", { name: "Stopp ändern", exact: true }).waitFor();
  });
  test.each(["C", "B", "A"])("selected %s coordinates survive refusal, reload and final calculation", async (mark) => {
    const { page } = opened;
    await pick(mark);
    const response = page.waitForResponse((r) => r.url().endsWith("/action") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Vorschau berechnen", exact: true }).click();
    await response;
    const saved = fixture.get(name).map;
    expect(saved.plan?.stops.find((stop) => stop.id === mark.toLowerCase())?.point).toEqual(mapAddress(mark.charCodeAt(0) - 65).point);
    if (mark !== "A") {
      expect(saved.issue?.code).toBe("GEO_BUDGET_EXHAUSTED");
      await page.reload();
      await page.getByRole("button", { name: "Stopp ändern", exact: true }).waitFor();
    } else {
      expect(saved.issue).toBeUndefined();
      expect(saved.route?.stops.map((stop) => stop.id)).toEqual(["a", "b", "c"]);
      expect(saved.route?.stops.map((stop) => stop.point)).toEqual([0, 1, 2].map((index) => mapAddress(index).point));
      await page.getByRole("button", { name: "Optionen", exact: true }).waitFor();
      if (process.env.MAP_RECOVERY_EVIDENCE_DIR)
        await page.screenshot({ path: `${process.env.MAP_RECOVERY_EVIDENCE_DIR}/03-route-light-${width}.png`, fullPage: true });
    }
  });
});
