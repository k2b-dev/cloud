import { describe, expect, test } from "bun:test";
import { GeoDocumentSchema, serializeGeoDocument } from "@k2b/cloud/geo/document";
import { renderNotebookBook } from "./book-renderer";
import { fictionalMap, fictionalRouteMap } from "./map.test-fixture";
import { mapLinkHref, notebookMapRevision, parseNotebookMapBlocks, renderNotebookMapFigure } from "./map-blocks";

describe("saved Notebook geo documents", () => {
  test("round-trips genuine geo fields and the entire saved route without recalculation", () => {
    const document = fictionalRouteMap();
    const markdown = serializeGeoDocument(document);
    expect(parseNotebookMapBlocks(markdown).blocks[0]?.document).toEqual(document);
    expect(GeoDocumentSchema.parse(document).route).toEqual(document.route);
  });
  test("validates IDs, coordinates, links, pin bounds and provenance", () => {
    const document = fictionalMap();
    expect(GeoDocumentSchema.safeParse({ ...document, pins: [...document.pins, document.pins[0]] }).success).toBe(false);
    expect(
      GeoDocumentSchema.safeParse({ ...document, pins: Array.from({ length: 21 }, (_, i) => ({ ...document.pins[0], id: String(i) })) })
        .success,
    ).toBe(false);
    const pin = document.pins[0]!;
    for (const patch of [
      { point: { lat: 91, lon: 10 } },
      { link: { type: "url", url: "javascript:alert(1)", label: "Bad" } },
      { provenance: undefined },
    ]) {
      expect(GeoDocumentSchema.safeParse({ ...document, pins: [{ ...pin, ...patch }] }).success).toBe(false);
    }
  });
  test("malformed saved route geometry becomes a diagnostic rather than crashing Book rendering", () => {
    const document = fictionalRouteMap();
    for (const polyline6 of ["xx", "_", "??_", "\u0001"]) {
      const invalid = { ...document, route: { ...document.route!, polyline6 } };
      expect(GeoDocumentSchema.safeParse(invalid).success).toBe(false);
      const result = renderNotebookBook({ markdown: `:::map\n${JSON.stringify(invalid)}\n:::`, notebookId: "Book01", locale: "en" });
      expect(result.html).toContain("This map block is invalid");
      expect(result.diagnostics).toHaveLength(1);
    }
  });
  test("JSON escaping cannot close a block or inject authored HTML", () => {
    const document = { ...fictionalMap(), title: '</figcaption><img src=x onerror="alert(1)">\n:::\n:::map' };
    const markdown = serializeGeoDocument(document);
    expect(markdown).not.toContain("<img");
    expect(parseNotebookMapBlocks(markdown).blocks).toHaveLength(1);
    expect(parseNotebookMapBlocks(markdown).blocks[0]?.document.title).toEqual(document.title);
    const html = renderNotebookBook({ markdown, notebookId: "Book01", locale: "en" }).html;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
  test("ignores literal blocks and diagnoses malformed/unclosed JSON", () => {
    const block = serializeGeoDocument(fictionalMap());
    expect(parseNotebookMapBlocks(`\`\`\`text\n${block}\n\`\`\``).blocks).toEqual([]);
    expect(parseNotebookMapBlocks(":::map\n{}\n:::").invalid).toEqual([1]);
    expect(parseNotebookMapBlocks(block.slice(0, -3)).invalid).toEqual([1]);
  });
  test("Book and block preview carry linked pins and complete route data", () => {
    const result = renderNotebookBook({
      markdown: `${serializeGeoDocument(fictionalMap())}\n\n${serializeGeoDocument(fictionalRouteMap())}`,
      notebookId: "Book01",
      locale: "de",
    });
    expect(result.blocks).toHaveLength(2);
    expect(result.html).toContain("data-map-document=");
    expect(result.html).toContain("/app/notebooks/Book01/notes/Note01?mode=book");
    expect(result.html).toContain("#heading-picknick");
    expect(result.html).toContain("https://example.org/museum");
    expect(result.html).toContain("Route Tag 2");
    expect(result.diagnostics).toEqual([]);
  });
  test("no-key and both budgets keep all saved data with sources and admin-only setup", () => {
    const document = fictionalMap();
    const balance = { exhausted: false, resetsAt: "2026-11-01T00:00:00Z" };
    for (const availability of [
      { configured: false, person: balance, cloud: balance },
      { configured: true, person: { ...balance, exhausted: true }, cloud: balance },
      { configured: true, person: balance, cloud: { ...balance, exhausted: true } },
    ]) {
      const html = renderNotebookMapFigure(document, { locale: "de", notebookId: "Book01", state: { availability } });
      expect(html).not.toContain('class="k2b-map-view');
      expect(html).toContain("https://www.openstreetmap.org/copyright");
      expect(html).toContain("Münster");
      expect(html).not.toContain("/admin/");
      const admin = renderNotebookMapFigure(document, { locale: "de", notebookId: "Book01", state: { availability, canAdmin: true } });
      expect(admin).toContain("/admin/settings?tab=places");
    }
  });
  test("PDF explicitly reports missing image and retains route, linked pins and provenance", () => {
    const result = renderNotebookBook({
      markdown: serializeGeoDocument(fictionalRouteMap()),
      notebookId: "Book01",
      locale: "en",
      print: true,
    });
    expect(result.omissions).toContainEqual({ code: "not_rendered", kind: "map", label: "Route Tag 2" });
    expect(result.html).toContain("https://www.openstreetmap.org/copyright");
    expect(result.html).toContain("Ulm");
    expect(result.html).not.toContain("<svg");
  });
  test("pin URLs preserve Notebook routes, mode and exact heading anchors", () => {
    expect(mapLinkHref({ type: "heading", noteId: "Note01", heading: "heading-picknick-2", label: "Picnic" }, "Book01", "readonly")).toBe(
      "/app/notebooks/Book01/notes/Note01?mode=readonly#heading-picknick-2",
    );
  });
});

test("route-only SSR retains its stop names when map configuration or budgets block tiles", () => {
  const document = fictionalRouteMap();
  const balance = { exhausted: false, resetsAt: "2026-11-01T00:00:00Z" };
  const html = renderNotebookMapFigure(document, {
    locale: "en",
    notebookId: "Book01",
    state: { availability: { configured: false, person: balance, cloud: balance } },
  });
  expect(html).toContain("Ulm Hbf");
  expect(html).toContain("Stuttgart Hbf");
  expect(html).not.toContain('class="k2b-map-view');
});

test("invalid maps report PDF omissions, while missing own headings link to the document top", () => {
  const invalid = renderNotebookBook({ markdown: ":::map\n{}\n:::", notebookId: "Book01", locale: "en", print: true });
  expect(invalid.omissions).toContainEqual(expect.objectContaining({ code: "invalid_block", kind: "map" }));
  const document = fictionalMap();
  const pin = document.pins[0]!;
  const markdown = serializeGeoDocument({
    ...document,
    pins: [{ ...pin, link: { type: "heading", noteId: "SELF01", heading: "heading-deleted", label: "Deleted heading" } }],
  });
  const result = renderNotebookBook({ markdown, notebookId: "Book01", noteId: "SELF01", locale: "en", print: true });
  expect(result.html).toContain('href="#top"');
  expect(result.html).not.toContain('href="#heading-deleted"');
  expect(result.blocks[0]?.html).not.toContain('href="#heading-deleted"');
});

test("offline map images replace the omission, preserve links and spell out every map source", () => {
  const markdown = serializeGeoDocument(fictionalMap());
  const result = renderNotebookBook({
    markdown,
    notebookId: "Book01",
    locale: "en",
    print: true,
    mapImages: new Map([[1, { src: "geo-map-0.jpg", width: 520, height: 186 }]]),
  });
  expect(result.omissions).toEqual([]);
  expect(result.html).toContain('src="geo-map-0.jpg"');
  expect(result.html).toContain('width="520"');
  expect(result.html).toContain("OpenMapTiles");
  expect(result.html).toContain("openstreetmap.org/copyright");
  expect(result.html).toContain("https://example.org/museum");
  expect(result.html).not.toContain("<svg");
});

test("the export revision accepts the full Markdown byte budget without JSON escape overhead", async () => {
  const markdown = "\\\n".repeat((256 * 1024) / 2);
  expect(new TextEncoder().encode(markdown).length).toBe(256 * 1024);
  expect(await notebookMapRevision(markdown)).toMatch(/^[a-f0-9]{64}$/);
  expect(await notebookMapRevision(markdown)).not.toBe(await notebookMapRevision(markdown.slice(1)));
});

test("PDF and browser Print preserve named block targets and keep self-note links internal", () => {
  const markdown = `# Guide\n\n[Jump](note://SELF01#guide) [Profile](#block-profile)\n\n@profile\n:::data\nowner: Fictional\n:::\n\n${serializeGeoDocument(fictionalMap())}`;
  for (const browserImages of [false, true]) {
    const result = renderNotebookBook({ markdown, notebookId: "Book01", noteId: "SELF01", locale: "en", print: true, browserImages });
    expect(result.html).toContain('href="#heading-guide"');
    expect(result.html).toContain('href="#block-profile"');
    expect(result.html).toContain('id="block-profile"');
  }
});
