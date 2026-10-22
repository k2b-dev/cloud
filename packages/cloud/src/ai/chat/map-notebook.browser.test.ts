import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { mapPlaces } from "../map.test-fixture";
import { startMapBrowserFixture } from "../map-browser.test-fixture";
import { aiMapNotebookContent } from "../map-notebook";

let fixture: Awaited<ReturnType<typeof startMapBrowserFixture>>;
let browser: Browser;
beforeAll(async () => {
  fixture = await startMapBrowserFixture({ view: "save" });
  browser = await launchBrowser();
}, 60000);
afterAll(async () => {
  await browser?.close();
  await fixture?.stop();
});
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

describe.each(["source", "note"])("partial save with changed %s", (changed) => {
  const scenario = `route-conflict-save-${changed}`;
  let opened: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => {
    largeSource(scenario);
    opened = await open(scenario);
    const { page } = opened;
    await page.route("**/actions/notebooks/note.edit", async (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ code: "NOT_ALLOWED", message: "Not allowed to edit this note." }),
      }),
    );
    await beginSave(page);
    await page.getByText("Not allowed to edit this note.", { exact: true }).waitFor();
    await page.unroute("**/actions/notebooks/note.edit");
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  test("refuses resume and retains the known recovery link", async () => {
    const { page } = opened;
    if (changed === "source") fixture.get(scenario).map.title = "Changed at the same revision";
    else fixture.notes.set(scenario, `${fixture.notes.get(scenario)}\nExternal edit`);
    await reopenSave(page);
    await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).click();
    await page.getByText(changed === "source" ? /Die Kartenquelle hat sich geändert/ : /Die Notiz hat sich geändert/).waitFor();
    await page.getByRole("link", { name: "Teilweise gespeicherte Notiz öffnen" }).waitFor();
    expect(await page.getByRole("button", { name: "Speichern fortsetzen", exact: true }).isDisabled()).toBe(true);
  });
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

describe.each(["owner", "conversation", "revision"] as const)("retained checkpoint %s boundary", (dimension) => {
  const scenario = `places-isolation-${dimension}`;
  let opened: Awaited<ReturnType<typeof open>>;
  let ownerUserId = "owner-one";
  let creates = 0;
  let initialKeys: string[] = [];
  const savedKeys = () => opened.page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("cloud.ai.map-save:v1:")));
  beforeAll(async () => {
    opened = await open(scenario);
    const { page } = opened;
    await page.route("**/export", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), ownerUserId } });
    });
    await page.route("**/actions/notebooks/note.create", async (route) => {
      creates++;
      await route.continue();
    });
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    initialKeys = await savedKeys();
    expect(initialKeys).toHaveLength(1);
  });
  afterAll(async () => {
    await opened?.context.close();
  });
  test("keeps the old receipt separate from the new save", async () => {
    const { page } = opened;
    if (dimension === "owner") ownerUserId = "owner-two";
    if (dimension === "revision") fixture.get(scenario).map.revision++;
    if (dimension === "conversation") await page.goto(`${fixture.server.url}?scenario=places-other-conversation-isolation`);
    else await page.reload();
    await beginSave(page);
    await page.getByRole("link", { name: "Im Notebook gespeichert", exact: true }).waitFor();
    const keys = await savedKeys();
    expect(keys).toHaveLength(2);
    expect(keys).toContain(initialKeys[0]!);
    expect(keys.filter((key) => key.includes("owner-one"))).toHaveLength(dimension === "owner" ? 1 : 2);
    expect(keys.filter((key) => key.includes("owner-two"))).toHaveLength(dimension === "owner" ? 1 : 0);
    expect(creates).toBe(2);
  });
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
