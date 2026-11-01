import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../packages/ui/test/browser";
import { build, packageRoot } from "../scripts/build";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const READ_ID = "Read0123456789ABCDEFGH";
const EDIT_ID = "Edit0123456789ABCDEFGH";
let directory: string;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let errors: string[];
let origin: string;
let fixture: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-browser-"));
  try {
    const outdir = join(directory, "dist");
    await build({ development: false, outdir });
    fixture = join(directory, "notizen.zip");
    // Use the real exporter so the UI receives exactly the supported ZIP format.
    const exporter = Bun.spawn([process.execPath, join(packageRoot, "scripts/fixture-export.ts"), fixture, "--now", String(NOW)], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const diagnostic = await new Response(exporter.stderr).text();
    if ((await exporter.exited) !== 0) throw new Error(`Fixture export failed: ${diagnostic}`);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname.startsWith("/api/")) return Response.json({ code: "unavailable" }, { status: 503 });
        const path = resolve(outdir, `.${decodeURIComponent(pathname)}`);
        if (path !== outdir && !path.startsWith(`${outdir}${sep}`)) return new Response(null, { status: 404 });
        const file = Bun.file(path === outdir ? join(outdir, "index.html") : path);
        return new Response((await file.exists()) ? file : Bun.file(join(outdir, "index.html")), {
          // An offline reload must use the worker, never the browser's HTTP cache.
          headers: { "Cache-Control": "no-store" },
        });
      },
    });
    origin = server.url.origin;
    browser = await launchBrowser();
  } catch (error) {
    await server?.stop(true);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}, 30_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await server?.stop(true);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

/** Only Date moves to the fixed instant; timers and animation frames keep running for real. */
const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

/** Marks the welcome note as done, so a test starts on the empty start page instead of in the welcome note. */
const skipWelcome = () => {
  if (!localStorage.getItem("k2b-notes.preferences"))
    localStorage.setItem("k2b-notes.preferences", JSON.stringify({ welcomeCreated: true }));
};

const openContext = async (serviceWorkers: "allow" | "block", firstVisit = false) => {
  context = await browser.newContext({ locale: "de-DE", viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", serviceWorkers });
  context.setDefaultTimeout(5_000);
  context.setDefaultNavigationTimeout(10_000);
  await context.addInitScript(pinPageClock, NOW);
  if (!firstVisit) await context.addInitScript(skipWelcome);
  page = await context.newPage();
  errors = pageErrors(page);
};

// WebKit sends a page's requests through its service worker, where page.route cannot stub them;
// only the offline test needs the worker and gets a context that allows it.
beforeEach(async () => {
  await openContext("block");
});

afterEach(async () => {
  try {
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
  }
});

// Rendered tables contain their own textboxes; target the Markdown editor itself.
const editor = () => page.getByRole("textbox").and(page.locator('[data-language="markdown"]'));
const cards = () => page.getByRole("main").getByRole("link");
const back = () => page.getByRole("banner").getByRole("link", { name: "Notizen", exact: true });

async function importNotes() {
  await page.goto(origin);
  await page.getByRole("textbox", { name: "Neue Notiz", exact: true }).waitFor();
  await page.getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
  await page.getByRole("menuitem", { name: "Notizen importieren", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    dialog.getByRole("button", { name: "Datei wählen", exact: true }).click(),
  ]);
  await chooser.setFiles(fixture);
  await dialog.getByRole("button", { name: "9 Notizen importieren", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("9 Notizen in diesem Browser", { exact: true }).waitFor();
}

async function createNote(text: string) {
  await page.goto(origin);
  await page.getByRole("textbox", { name: "Neue Notiz", exact: true }).fill(text);
  await page.waitForURL(/\/n\/[A-Za-z0-9]{22}$/);
  // Wait for the debounced title before testing persistence with a reload.
  await editor().waitFor();
  await page.waitForFunction((text) => document.querySelector('[role="textbox"]')?.getAttribute("aria-label") === text, text);
  return page.url();
}

async function box(locator: Locator) {
  await locator.waitFor();
  const result = await locator.boundingBox();
  if (!result) throw new Error("Visible control has no bounding box");
  return result;
}

describe("k2b notes · Produktions-SPA", () => {
  test("erster Besuch: die Willkommensnotiz öffnet sich im Editor und kommt nach dem Löschen nicht wieder", async () => {
    await context.close();
    await openContext("block", true);
    await page.goto(origin);
    await page.waitForURL(/\/n\/[A-Za-z0-9]{22}$/);
    await page.getByRole("textbox", { name: "Willkommen", exact: true }).waitFor();
    expect(await editor().innerText()).toContain("Tippe / für mehr.");
    // A real note, rendered like any other: notice, chart from its table, checklist boxes and a tag pill.
    await page.locator(".cm-notice-card-widget").first().waitFor();
    await page.locator(".cm-query-block-preview svg").first().waitFor();
    expect(await page.locator(".custom-list-task-marker").count()).toBe(3);
    // The sum row is computed and stays out of the chart built from the same table.
    await page.locator(".md-formula-ok", { hasText: "183" }).waitFor();
    // The table's `@kaffee` anchor shows as a quiet label, not as raw Markdown.
    await page.locator(".cm-named-block-handle", { hasText: /^kaffee$/ }).waitFor();
    expect(await editor().innerText()).not.toContain("@kaffee");
    // No footer under the editor; the legal pages sit in the note's menu.
    expect(await page.getByRole("contentinfo").count()).toBe(0);
    await page.getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
    expect(await page.getByRole("menuitem", { name: "Datenschutz", exact: true }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator(".n-tagpill", { hasText: "#start" }).click();
    await page.waitForURL(`${origin}/?tag=start`);
    await page.getByText("1 Notiz in diesem Browser", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("1 Notiz in diesem Browser", { exact: true }).waitFor();
    // Deleted, the welcome note does not come back; the empty start page opens a plain draft.
    await cards().first().click();
    await page.getByRole("textbox", { name: "Willkommen", exact: true }).waitFor();
    await page.getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
    await page.getByRole("menuitem", { name: "Notiz löschen", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Löschen", exact: true }).click();
    await page.getByRole("textbox", { name: "Neue Notiz", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("textbox", { name: "Neue Notiz", exact: true }).waitFor();
    expect(page.url()).toBe(`${origin}/`);
  }, 25_000);

  test("leere Startseite: Entwurf wird gespeichert und bleibt nach Reload und Rückkehr sichtbar", async () => {
    await page.goto(origin);
    const draft = page.getByRole("textbox", { name: "Neue Notiz", exact: true });
    await draft.waitFor();
    expect(
      await draft.evaluate((element) => {
        const copy = element.cloneNode(true);
        if (!(copy instanceof HTMLElement)) throw new Error("Expected an editor element");
        copy.querySelector(".cm-placeholder")?.remove();
        return copy.textContent?.trim();
      }),
    ).toBe("");
    const text = "Mein erster Gedanke";
    await draft.fill(text);
    await page.waitForURL(/\/n\/[A-Za-z0-9]{22}$/);
    await page.getByRole("textbox", { name: text, exact: true }).waitFor();
    await page.reload();
    await page.getByRole("textbox", { name: text, exact: true }).waitFor();
    expect(await editor().innerText()).toBe(text);
    await back().click();
    await page.waitForURL(`${origin}/`);
    await page.getByText("1 Notiz in diesem Browser", { exact: true }).waitFor();
    expect(await cards().count()).toBe(1);
    expect(await cards().first().innerText()).toContain(text);
  }, 20_000);

  test("ZIP importieren: neun Karten plus Weiterschreiben, Tag-Filter überlebt Reload", async () => {
    await importNotes();
    const regularCount = await cards().filter({ hasNotText: "Weiterschreiben" }).count();
    expect(await cards().filter({ hasText: "Weiterschreiben" }).count()).toBe(1);
    await page
      .getByRole("group", { name: "Nach Tag filtern" })
      .getByRole("button", { name: /^verein\s+2$/ })
      .click();
    await page.waitForURL(`${origin}/?tag=verein`);
    expect(await cards().count()).toBe(2);
    await page.reload();
    await page.getByRole("button", { name: /^verein\s+2$/, pressed: true }).waitFor();
    expect(new URL(page.url()).searchParams.get("tag")).toBe("verein");
    expect(await cards().count()).toBe(2);
    expect(await cards().allTextContents()).toEqual(
      expect.arrayContaining([expect.stringContaining("Gartenverein"), expect.stringContaining("Satzungsentwurf")]),
    );
    // The "Weiterschreiben" card stands in for the newest note's own card, as in mockup v4.
    expect(regularCount).toBe(8);
  }, 20_000);

  test("Control+K: Volltexttreffer öffnen und eine erfolglose Suche anbieten", async () => {
    await importNotes();
    await page.keyboard.press("Control+k");
    const search = page.getByRole("combobox", { name: "Suchbegriff", exact: true });
    await search.fill("tram");
    await page
      .getByRole("group", { name: "Im Text", exact: true })
      .getByRole("option", { name: /Lissabon im März/ })
      .first()
      .waitFor();
    await search.press("Enter");
    await page.waitForURL(`${origin}/n/lissabon00000000000000`);
    await page.getByRole("textbox", { name: "Lissabon im März", exact: true }).waitFor();
    await page.keyboard.press("Control+k");
    await search.fill("kürbis");
    await page.getByText("Nichts zu „kürbis“", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Notiz „kürbis“ anlegen", exact: true }).isVisible()).toBe(true);
  }, 20_000);

  test("Teilen: Zustimmung, sichtbarer 503-Fehler, Retry mit Links und einmaligem Cloud-Hinweis", async () => {
    await createNote("Eine geteilte Notiz");
    await page.getByRole("button", { name: "Teilen", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const submit = dialog.getByRole("button", { name: "Links erstellen", exact: true });
    expect(await submit.isDisabled()).toBe(true);
    await dialog.getByRole("checkbox", { name: /Ich halte mich an die Nutzungsbedingungen/ }).check();
    expect(await submit.isDisabled()).toBe(true);
    await dialog.getByRole("checkbox", { name: /Ich habe die Datenschutzhinweise gelesen/ }).check();
    expect(await submit.isEnabled()).toBe(true);
    const [response] = await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pads" && response.request().method() === "POST"),
      submit.click(),
    ]);
    expect(response.status()).toBe(503);
    await dialog.getByRole("alert").filter({ hasText: "Hochladen hat nicht geklappt." }).waitFor();
    expect(await dialog.getByText(`/p/${READ_ID}`, { exact: false }).count()).toBe(0);
    expect(READ_ID).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(EDIT_ID).toMatch(/^[A-Za-z0-9]{22}$/);
    await page.route("**/api/pads", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 201, json: { readId: READ_ID, editId: EDIT_ID } });
    });
    await dialog.getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await dialog.getByRole("heading", { name: "Notiz ist geteilt", exact: true }).waitFor();
    for (const id of [READ_ID, EDIT_ID])
      expect(await dialog.getByText(`${new URL(origin).host}/p/${id}`, { exact: true }).isVisible()).toBe(true);
    expect(await dialog.getByRole("img", { name: "QR-Code des Bearbeiten-Links", exact: true }).isVisible()).toBe(true);
    expect(await dialog.getByText("Auf dem Handy weiterschreiben", { exact: true }).isVisible()).toBe(true);
    const cloud = dialog.getByRole("link", { name: /Gefällt dir das\? Mit Cloud/ });
    expect(await cloud.isVisible()).toBe(true);
    await dialog.getByRole("button", { name: "Fertig", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.reload();
    await editor().waitFor();
    await page.getByRole("button", { name: "Teilen", exact: true }).click();
    await dialog.getByRole("heading", { name: "Notiz ist geteilt", exact: true }).waitFor();
    expect(await cloud.count()).toBe(0);
  }, 25_000);

  test("Geteilte Notiz: jede Eingabe erreicht das Dokument, kein Editor-Plugin fällt aus", async () => {
    // Writing the record on each keystroke once reconfigured the editor inside its own update; CodeMirror then switched
    // the Yjs binding off and later typing never reached the note.
    const crashes: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("plugin crashed")) crashes.push(message.text());
    });
    await page.route("**/api/pads", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 201, json: { readId: READ_ID, editId: EDIT_ID } });
    });
    await createNote("Geteilt");
    await page.getByRole("button", { name: "Teilen", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: /Ich halte mich an die Nutzungsbedingungen/ }).check();
    await dialog.getByRole("checkbox", { name: /Ich habe die Datenschutzhinweise gelesen/ }).check();
    await dialog.getByRole("button", { name: "Links erstellen", exact: true }).click();
    await dialog.getByRole("button", { name: "Fertig", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await editor().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" eins");
    await page.keyboard.type(" zwei");
    // The title is derived from the note's Yjs text, so it only changes when typing reached the document.
    await page.waitForFunction(() => document.querySelector('[role="textbox"]')?.getAttribute("aria-label") === "Geteilt eins zwei");
    await page.reload();
    await editor().waitFor();
    await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("zwei"), undefined, { timeout: 5_000 });
    expect(crashes).toEqual([]);
  }, 25_000);

  test("Löschen einer geteilten Notiz: mit Server weg, ohne Server ausstehend, ohne Wiederholungsschleife", async () => {
    await importNotes();
    let deletes = 0;
    let serverUp = false;
    await page.route("**/api/pads/*", (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deletes += 1;
      return serverUp ? route.fulfill({ status: 204 }) : route.fulfill({ status: 503, json: { code: "unavailable" } });
    });
    const remove = async () => {
      await cards().filter({ hasText: "Lissabon im März" }).first().click();
      await page.getByRole("button", { name: "Weitere Aktionen", exact: true }).click();
      await page.getByRole("menuitem", { name: "Notiz löschen", exact: true }).click();
      const dialog = page.getByRole("dialog");
      expect(await dialog.getByRole("checkbox", { name: /Auch die geteilte Fassung löschen/ }).isChecked()).toBe(true);
      await dialog.getByRole("button", { name: "Löschen", exact: true }).click();
      await page.getByRole("heading", { name: "Notizen", exact: true }).waitFor();
    };
    // Without the server the note stays as a pending deletion, and nothing retries in a loop.
    await remove();
    await page
      .getByText(/Löschen ausstehend/)
      .first()
      .waitFor();
    await page.waitForTimeout(1_500);
    expect(deletes).toBe(1);
    expect(await cards().filter({ hasText: "Lissabon im März" }).count()).toBe(1);
    // Back online, the retry deletes it once.
    serverUp = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await cards().filter({ hasText: "Lissabon im März" }).first().waitFor({ state: "detached" });
    expect(deletes).toBe(2);
  }, 25_000);

  test("Notizwechsel: Statusbreite und Teilen-Knopf bleiben an ihrem Platz", async () => {
    await importNotes();
    const measurements = [];
    for (const title of ["Lauftraining Herbst", "Lissabon im März", "Gartenverein – Treffen 4. November"]) {
      await cards().filter({ hasText: title }).first().click();
      await page.getByRole("textbox", { name: title, exact: true }).waitFor();
      const status = page.getByRole("banner").getByRole("status");
      await status.waitFor();
      if (title === "Lauftraining Herbst") expect(await status.innerText()).toBe("Nur auf diesem Gerät");
      else await status.filter({ hasText: "Offline · auf diesem Gerät gesichert" }).waitFor();
      await settled(page);
      measurements.push({ status: await box(status), share: await box(page.getByRole("button", { name: "Teilen", exact: true })) });
      await back().click();
      await page.getByRole("heading", { name: "Notizen", exact: true }).waitFor();
    }
    const first = measurements[0]!;
    for (const next of measurements.slice(1)) {
      expect(Math.abs(next.status.width - first.status.width)).toBeLessThanOrEqual(1);
      for (const dimension of ["x", "y", "width", "height"] as const)
        expect(Math.abs(next.share[dimension] - first.share[dimension])).toBeLessThanOrEqual(1);
    }
  }, 20_000);

  test("Offline-Reload: aktiver Service Worker lädt die App und ihre lokalen Notizen", async () => {
    await context.close();
    await openContext("allow");
    await importNotes();
    const previousCount = await cards().count();
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated", undefined, { timeout: 10_000 });
    await context.setOffline(true);
    try {
      const response = await page.reload();
      expect(response?.fromServiceWorker()).toBe(true);
      await page.getByText("9 Notizen in diesem Browser", { exact: true }).waitFor();
      expect(page.url()).toBe(`${origin}/`);
      expect(await cards().count()).toBe(previousCount);
      for (const title of ["Lauftraining Herbst", "Lissabon im März", "Sauerteig – Notizen"]) {
        expect(await cards().filter({ hasText: title }).first().isVisible()).toBe(true);
      }
      // The editor presentation is part of the offline app, not only the plain editor.
      await cards().filter({ hasText: "Lauftraining Herbst" }).first().click();
      await page.locator(".n-tagpill", { hasText: "#sport" }).waitFor();
    } finally {
      await context.setOffline(false);
    }
  }, 20_000);

  test("Handy 390×844: zwei Kartenspalten, runder Neuerstellen-Knopf und Such-Icon", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await importNotes();
    await settled(page);
    const regular = cards().filter({ hasNotText: "Weiterschreiben" });
    const first = await box(regular.nth(0));
    const second = await box(regular.nth(1));
    const third = await box(regular.nth(2));
    expect(first.width).toBeGreaterThan(140);
    expect(first.width).toBeLessThan(195);
    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
    expect(second.x).toBeGreaterThan(first.x + first.width);
    expect(Math.abs(third.x - first.x)).toBeLessThanOrEqual(1);
    expect(third.y).toBeGreaterThan(first.y);
    const create = page.getByRole("button", { name: "Neue Notiz", exact: true });
    const fab = await box(create);
    expect(Math.abs(fab.width - fab.height)).toBeLessThanOrEqual(1);
    expect(fab.x + fab.width).toBeGreaterThan(350);
    expect(fab.y + fab.height).toBeGreaterThan(800);
    expect(fab.x + fab.width).toBeLessThanOrEqual(390);
    expect(fab.y + fab.height).toBeLessThanOrEqual(844);
    const radius = await create.evaluate((element) => parseFloat(getComputedStyle(element).borderRadius));
    const search = page.getByRole("button", { name: "Überall suchen", exact: true });
    expect((await box(search)).width).toBeLessThan(60);
    expect((await search.innerText()).trim()).toBe("");
    await search.click();
    await page.getByRole("combobox", { name: "Suchbegriff", exact: true }).waitFor();
    // Mockup v4: a rounded square, 56 px with an 18 px radius.
    expect(radius).toBe(18);
  }, 20_000);

  test("Handy: „Tabelle“ in der Leiste fügt eine Tabelle ein und öffnet in einer Zelle das Tabellenmenü", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await createNote("Sommerfest 2027");
    await editor().click();
    await page.keyboard.press("ControlOrMeta+End");
    const bar = page.locator(".n-accessory");
    const insert = bar.getByRole("button", { name: "Tabelle", exact: true });
    const place = await box(insert);
    await insert.click();
    const header = page.locator('.k2b-ste-cell[data-r="0"][data-c="0"]');
    await page.waitForFunction(() => document.activeElement?.matches('.k2b-ste-cell[data-r="0"][data-c="0"]'));
    // In a cell the same place opens the shared cell menu, as in Notebooks.
    const menu = bar.getByRole("button", { name: "Tabelle bearbeiten", exact: true });
    expect(await box(menu)).toEqual(place);
    expect(await bar.locator(".ti-dots").count()).toBe(0);
    await menu.click();
    const sheet = page.locator(".k2b-gesture-menu__sheet-menu");
    await sheet.getByRole("menuitemcheckbox", { name: "Kopfzeile" }).waitFor();
    await page.getByRole("button", { name: "Fertig", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.matches('.k2b-ste-cell[data-r="0"][data-c="0"]'));
    expect(await header.isVisible()).toBe(true);
  }, 20_000);
});
