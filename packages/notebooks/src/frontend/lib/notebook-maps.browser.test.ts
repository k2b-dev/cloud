import { afterAll, beforeAll, expect, test } from "bun:test";
import { GeoMapSnapshotManifestSchema } from "@k2b/cloud/contracts/geo-snapshot";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../../ui/test/browser";
import { notebookMapRevision, parseNotebookMapBlocks } from "../../lib/map-blocks";
import { createNotebookMapFixtureServer } from "./notebook-maps.browser-server";

declare global {
  interface Window {
    notebookEditorFixture: { markdown(): string; typePrefix(): void; undo(): void; redo(): void; remoteChange(): void; dispose(): void };
  }
}
let browser: Browser;
let fixture: Awaited<ReturnType<typeof createNotebookMapFixtureServer>>;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  fixture = await createNotebookMapFixtureServer();
  server = fixture.server;
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await fixture?.dispose();
});
const first = (page: Page) => page.locator("figure.notebook-map").first();
async function open(query = "", width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${server.url}${query}`);
  await page.locator("figure.notebook-map[data-map-enhanced]").first().waitFor();
  return { context, page };
}

test("saved pins have synchronized keyboard selection and safe note, heading and website links", async () => {
  const { context, page } = await open();
  try {
    const list = first(page).getByRole("listbox", { name: "Pins", exact: true });
    await list.focus();
    await page.keyboard.press("End");
    expect(await list.locator('[aria-selected="true"]').innerText()).toContain("Glacis-Park");
    await page.keyboard.press("Home");
    expect(await list.locator('[aria-selected="true"]').innerText()).toContain("Münster");
    expect(await first(page).getByRole("link", { name: "Picknick Samstag" }).getAttribute("href")).toContain("#heading-picknick");
    expect(await first(page).getByRole("link", { name: "Website" }).getAttribute("href")).toBe("https://example.org/museum");
    await first(page).getByRole("button", { name: "Kartenaktionen", exact: true }).click();
    await page.getByRole("menuitem", { name: "Als Liste", exact: true }).click();
    expect(await first(page).locator(".k2b-map-view").count()).toBe(0);
    expect(await first(page).locator(".notebook-map__source").innerText()).toContain("Geoapify");
  } finally {
    await context.close();
  }
});

test("place search adds a pin through link confirmation; cancel leaves the document untouched", async () => {
  const { context, page } = await open();
  try {
    const search = first(page).getByRole("combobox", { name: "Ort für einen Pin suchen" });
    await search.fill("Spatz");
    await first(page)
      .getByRole("button", { name: /Ulmer Spatz/ })
      .click();
    await first(page).getByRole("button", { name: "Abbrechen", exact: true }).click();
    expect(await first(page).locator("[data-pin-id]").count()).toBe(4);
    await search.fill("Spatz");
    await first(page)
      .getByRole("button", { name: /Ulmer Spatz/ })
      .click();
    await first(page).getByRole("textbox", { name: "Website-Adresse" }).fill("https://example.org/spatz");
    await first(page).getByRole("button", { name: "Pin hinzufügen", exact: true }).click();
    expect(await first(page).locator("[data-pin-id]").count()).toBe(5);
    const saved = await page.locator("#saved").textContent();
    expect(saved).toContain("https://example.org/spatz");
    expect(saved).toContain("provenance");
  } finally {
    await context.close();
  }
});

test("empty search and empty map have a visible recovery path", async () => {
  const { context, page } = await open("?state=empty");
  try {
    expect(await first(page).innerText()).toContain("Noch keine Pins.");
    const search = first(page).getByRole("combobox", { name: "Ort für einen Pin suchen" });
    await search.fill("Nichts");
    await first(page).getByText("Keine Orte gefunden.", { exact: false }).waitFor();
    await search.fill("Spatz");
    await first(page)
      .getByRole("button", { name: /Ulmer Spatz/ })
      .waitFor();
    await page.keyboard.press("Escape");
    expect(await first(page).locator(".notebook-map__suggestions").count()).toBe(0);
  } finally {
    await context.close();
  }
});

test("read-only maps have no writes and retain saved route and source lists when unavailable", async () => {
  for (const state of ["off", "person", "cloud"]) {
    const { context, page } = await open(`?state=${state}&readonly=1`);
    try {
      expect(await page.locator(".k2b-map-view").count()).toBe(0);
      expect(await first(page).getByRole("combobox").count()).toBe(0);
      expect(await page.locator(".notebook-map__pin").count()).toBe(4);
      expect(await page.getByText("Route: Geoapify · OpenStreetMap", { exact: true }).count()).toBe(1);
      expect(await page.locator('a[href^="/admin"]').count()).toBe(0);
    } finally {
      await context.close();
    }
  }
});

test("route calculation saves the full returned route; stale writes stay visible as conflicts", async () => {
  const { context, page } = await open("?conflict=1");
  try {
    await first(page).getByRole("button", { name: "Kartenaktionen", exact: true }).click();
    await page.getByRole("menuitem", { name: "Route durch die Pins speichern", exact: true }).click();
    await first(page).getByRole("button", { name: "Route durch die Pins speichern", exact: true }).click();
    await first(page).getByRole("alert").waitFor();
    expect(await first(page).getByRole("alert").innerText()).toContain("während der Bearbeitung geändert");
  } finally {
    await context.close();
  }
});

test("phone, tablet and dark keep controls and linked rows within the document", async () => {
  for (const width of [390, 820, 1440]) {
    const { context, page } = await open("", width);
    try {
      await page.locator("html").evaluate((root) => root.classList.add("dark"));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      const mapHeight = await first(page)
        .locator(".k2b-map-view")
        .evaluate((element) => element.getBoundingClientRect().height);
      expect(mapHeight).toBe(width === 390 ? 230 : 320);
      const pinsInside = await first(page)
        .locator(".k2b-map-view")
        .evaluate((map) => {
          const box = map.getBoundingClientRect();
          return [...map.querySelectorAll(".k2b-map-view__pin")].every((pin) => {
            const p = pin.getBoundingClientRect();
            return p.left >= box.left && p.right <= box.right && p.top >= box.top && p.bottom <= box.bottom;
          });
        });
      expect(pinsInside).toBe(true);
    } finally {
      await context.close();
    }
  }
});

test("style failure keeps saved pins, exposes retry and recovers in place", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let failed = true;
  await page.route("**/api/geo/style?**", (route) =>
    failed ? route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"GEO_BUSY"}' }) : route.continue(),
  );
  try {
    await page.goto(server.url.origin);
    await first(page).locator('.k2b-map-view[data-state="error"]').waitFor();
    expect(await first(page).locator(".notebook-map__pin").count()).toBe(4);
    expect(await first(page).locator(".k2b-map-view__pin").count()).toBe(4);
    const before = await first(page).boundingBox();
    failed = false;
    await first(page).getByRole("button", { name: "Erneut versuchen", exact: true }).click();
    await first(page).locator('.k2b-map-view[data-state="ready"]').waitFor();
    expect(await first(page).boundingBox()).toEqual(before);
  } finally {
    await context.close();
  }
});

test("search failures preserve the query, show retry and recover after correction", async () => {
  const { context, page } = await open();
  try {
    const search = first(page).getByRole("combobox", { name: "Ort für einen Pin suchen" });
    await search.fill("Fehler");
    await first(page).getByRole("alert").waitFor();
    expect(await search.inputValue()).toBe("Fehler");
    expect(await first(page).getByRole("button", { name: "Erneut versuchen", exact: true }).count()).toBe(1);
    await search.fill("Spatz");
    await first(page)
      .getByRole("button", { name: /Ulmer Spatz/ })
      .waitFor();
    expect(await first(page).getByRole("alert").count()).toBe(0);
  } finally {
    await context.close();
  }
});

test("a long valid address can be saved without throwing or losing its provenance", async () => {
  const { context, page } = await open();
  try {
    await first(page).getByRole("combobox", { name: "Ort für einen Pin suchen" }).fill("Lang");
    await first(page).locator('.notebook-map__suggestions [role="option"] button').click();
    await first(page).getByRole("combobox", { name: "Verknüpfen mit", exact: true }).click();
    await page.getByRole("option", { name: "Ohne Verknüpfung", exact: true }).click();
    await first(page).getByRole("button", { name: "Pin hinzufügen", exact: true }).click();
    await page.waitForFunction(() => !!document.querySelector("#saved")?.textContent);
    const saved = await page.locator("#saved").textContent();
    expect(saved).toContain('"label":"' + "A".repeat(300) + '"');
    expect(saved).toContain("provenance");
  } finally {
    await context.close();
  }
});

test("the actual editor writes only the selected duplicate block to Yjs and supports undo", async () => {
  const { context, page } = await open("?editor=1&theme=dark");
  try {
    await page.locator("figure[data-map-enhanced]").nth(1).waitFor();
    await page.evaluate(() => window.notebookEditorFixture.typePrefix());
    await page.waitForFunction(() => document.querySelectorAll(".cm-query-block-widget figure[data-map-enhanced]").length === 2);
    const before = await page.evaluate(() => window.notebookEditorFixture.markdown());
    const second = page.locator("figure.notebook-map").nth(1);
    await second.getByRole("button", { name: "Kartenaktionen", exact: true }).click();
    await page.getByRole("menuitem", { name: "Pin entfernen", exact: true }).click();
    await page.waitForFunction(() => window.notebookEditorFixture.markdown().includes("savedAt"));
    const changed = await page.evaluate(() => window.notebookEditorFixture.markdown());
    const blocks = changed.split(":::map");
    expect(blocks[1]).toContain('"id":"n1"');
    expect(blocks[2]).not.toContain('"id":"n1"');
    await page.evaluate(() => window.notebookEditorFixture.undo());
    expect(await page.evaluate(() => window.notebookEditorFixture.markdown())).toBe(before);
    await page.evaluate(() => window.notebookEditorFixture.redo());
    expect(await page.evaluate(() => window.notebookEditorFixture.markdown())).toBe(changed);
    expect(fixture.requests.some((path) => path === "/api/geo/style")).toBe(true);
  } finally {
    await context.close();
  }
});

test("place pins can link to an authorized note heading through the existing Notebook picker", async () => {
  const { context, page } = await open();
  try {
    await first(page).getByRole("combobox", { name: "Ort für einen Pin suchen" }).fill("Spatz");
    await first(page)
      .getByRole("button", { name: /Ulmer Spatz/ })
      .click();
    await first(page).getByRole("combobox", { name: "Verknüpfen mit", exact: true }).click();
    await page.getByRole("option", { name: "Überschrift", exact: true }).click();
    await first(page).getByRole("button", { name: "Notiz wählen", exact: true }).click();
    await page.getByPlaceholder("Notiz zum Verlinken suchen…", { exact: true }).fill("Picknick");
    await page.getByRole("option", { name: /Picknick Samstag/ }).click();
    await first(page).getByRole("combobox", { name: "Überschrift", exact: true }).click();
    await page.getByRole("option", { name: "picknick", exact: true }).click();
    await first(page).getByRole("button", { name: "Pin hinzufügen", exact: true }).click();
    const saved = await page.locator("#saved").textContent();
    expect(saved).toContain('"type":"heading","noteId":"Note01","heading":"heading-picknick"');
    expect(await first(page).locator("[data-pin-id]").last().getByRole("link").getAttribute("href")).toBe(
      "/app/notebooks/Book01/notes/Note01?mode=book#heading-picknick",
    );
  } finally {
    await context.close();
  }
});

test("successful route calculation persists the complete route without recomputing on reading", async () => {
  const { context, page } = await open();
  try {
    await first(page).getByRole("button", { name: "Kartenaktionen", exact: true }).click();
    await page.getByRole("menuitem", { name: "Route durch die Pins speichern", exact: true }).click();
    await first(page).getByRole("button", { name: "Route durch die Pins speichern", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#saved")?.textContent?.includes("polyline6"));
    const saved = await page.locator("#saved").textContent();
    expect(saved).toContain('"distanceMeters":95000');
    expect(saved).toContain('"legs":');
    expect(saved).toContain('"inputHash":');
    expect(saved).toContain('"computedAt":"2026-10-19T12:00:00.000Z"');
    expect(await first(page).locator(".notebook-map__route-summary").innerText()).toContain("95 km");
  } finally {
    await context.close();
  }
});

test("PDF preview waits for complete map PNGs, preserves sources and uploads images with the document revision", async () => {
  const { context, page } = await open("?pdf=1");
  try {
    const preview = page.locator(".notebook-map-export__preview");
    await preview.locator("img.notebook-map__image").nth(1).waitFor();
    expect(await preview.locator("img.notebook-map__image").count()).toBe(2);
    expect(await preview.innerText()).toContain("OpenMapTiles");
    const download = page.getByRole("button", { name: "PDF herunterladen", exact: true }).last();
    await download.click();
    await page.waitForFunction(() => !document.querySelector(".notebook-map-export__preview"));
    const form = fixture.uploads.at(-1)!;
    const manifest = GeoMapSnapshotManifestSchema.parse(JSON.parse(String(form.get("mapSnapshots"))));
    const input: unknown = JSON.parse(String(form.get("input")));
    if (!input || typeof input !== "object" || !("markdown" in input) || typeof input.markdown !== "string")
      throw new Error("Missing export Markdown");
    expect(manifest.revision).toBe(await notebookMapRevision(input.markdown));
    expect(manifest.images.map(({ id }) => id)).toEqual(parseNotebookMapBlocks(input.markdown).blocks.map(({ line }) => `line-${line}`));
    expect(manifest.images).toHaveLength(2);
    expect(manifest.revision).toMatch(/^[a-f0-9]{64}$/);
    for (const image of manifest.images) {
      const data = form.get(`map-snapshot-${image.id}`);
      expect(data).toBeInstanceOf(Blob);
      if (!(data instanceof Blob)) throw new Error("Missing PNG");
      expect(data.type).toBe("image/png");
      expect(data.size).toBeGreaterThan(1000);
      const header = new DataView(await data.slice(0, 24).arrayBuffer());
      expect(header.getUint32(16)).toBe(image.width);
      expect(header.getUint32(20)).toBe(image.height);
    }
  } finally {
    await context.close();
  }
});

test("PDF no-key preview keeps lists and sources, offers retry and exports fallback only explicitly", async () => {
  const { context, page } = await open("?pdf=1&state=off");
  try {
    await page.getByRole("button", { name: "Mit Quellenlisten fortfahren", exact: true }).waitFor();
    const preview = page.locator(".notebook-map-export__preview");
    expect(await preview.innerText()).toContain("Münster");
    expect(await preview.innerText()).toContain("Geoapify");
    expect(await preview.locator("img.notebook-map__image").count()).toBe(0);
    expect(await page.getByRole("button", { name: "PDF herunterladen", exact: true }).last().isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Mit Quellenlisten fortfahren", exact: true }).click();
    await page.locator("[data-pdf-omissions]").waitFor();
    expect(await page.getByRole("button", { name: "Erneut versuchen", exact: true }).last().isVisible()).toBe(true);
    await page.getByRole("button", { name: "Erneut versuchen", exact: true }).last().click();
    await page.getByRole("button", { name: "Mit Quellenlisten fortfahren", exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

test("pending map export gates both actions; closing cancels preparation without an upload", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/geo/style?**", async (route) => {
    await pending;
    await route.continue().catch(() => {});
  });
  const count = fixture.uploads.length;
  try {
    await page.goto(`${server.url}?pdf=1`);
    await page.locator(".notebook-map-export__preview .k2b-map-view").waitFor();
    expect(await page.getByRole("button", { name: "PDF herunterladen", exact: true }).last().isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Drucken", exact: true }).last().isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Abbrechen", exact: true }).last().click();
    await page.locator(".notebook-map-export__preview").waitFor({ state: "detached" });
    release();
    expect(fixture.uploads.length).toBe(count);
  } finally {
    release();
    await context.close();
  }
});

test("Print receives decoded maps and ordinary attachments and removes its temporary document afterward", async () => {
  const { context, page } = await open("?pdf=1&images=1");
  try {
    await page.locator(".notebook-map-export__preview img.notebook-map__image").nth(1).waitFor();
    const preview = page.locator(".notebook-map-export__preview");
    expect(await preview.innerText()).not.toContain("NOTEBOOKBOOKSLOT");
    expect(await preview.getByRole("img", { name: "Fictional attachment", exact: true }).getAttribute("src")).toContain(
      "/attachments/Img001/content",
    );
    await page.evaluate(() => {
      window.print = () => {
        const images = [...document.querySelectorAll<HTMLImageElement>(".notebook-map-print-document img.notebook-map__image")];
        document.body.dataset.printedMaps = String(images.filter((image) => image.complete && image.naturalWidth > 0).length);
        const attachment = document.querySelector<HTMLImageElement>('.notebook-map-print-document img[alt="Fictional attachment"]');
        document.body.dataset.printedAttachment = String(Boolean(attachment?.complete && attachment.naturalWidth > 0));
      };
    });
    await page.getByRole("button", { name: "Drucken", exact: true }).last().click();
    await page.waitForFunction(() => document.body.dataset.printedMaps === "2" && document.body.dataset.printedAttachment === "true");
    expect(await page.locator(".notebook-map-print-document").count()).toBe(0);
  } finally {
    await context.close();
  }
});

test("closing Print while an ordinary image decodes removes the temporary document without printing", async () => {
  const { context, page } = await open("?pdf=1&images=1");
  try {
    await page.locator(".notebook-map-export__preview img.notebook-map__image").nth(1).waitFor();
    await page.evaluate(() => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        if (this.alt === "Fictional attachment" && this.closest(".notebook-map-print-document")) {
          document.body.dataset.printImageDecoding = "true";
          await new Promise<void>((resolve) => document.addEventListener("release-print-image", () => resolve(), { once: true }));
        }
      };
      window.print = () => {
        document.body.dataset.unexpectedPrint = "true";
      };
    });
    await page.getByRole("button", { name: "Drucken", exact: true }).last().click();
    await page.waitForFunction(() => document.body.dataset.printImageDecoding === "true");
    await page.getByRole("button", { name: "Abbrechen", exact: true }).last().click();
    await page.locator(".notebook-map-print-document").waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.body.dataset.unexpectedPrint)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.classList.contains("notebook-map-printing"))).toBe(false);
    await page.evaluate(() => document.dispatchEvent(new Event("release-print-image")));
  } finally {
    await context.close();
  }
});
