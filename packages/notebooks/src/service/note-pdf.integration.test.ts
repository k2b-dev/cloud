import { beforeAll, expect, test } from "bun:test";
import { geoMapSnapshotFingerprint, geoMapSnapshotPart } from "@k2b/cloud/contracts/geo-snapshot";
import { serializeGeoDocument } from "@k2b/cloud/geo/document";
import { type GotenbergConfig, prepareGeoMapSnapshotAssets, renderHtmlToPdfWithConfig } from "@k2b/cloud/services/pdf";
import sharp from "sharp";
import { pdfFonts, pdfImages, pdfLigatures, pdfText, pdfTitle } from "../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { fictionalMap, fictionalRouteMap } from "../lib/map.test-fixture";
import { notebookMapRevision, parseNotebookMapBlocks } from "../lib/map-blocks";
import { buildNotePdfHtml } from "./note-pdf";

const NOTICES = ["note", "info", "success", "warning", "danger"] as const;

suiteFor("gotenberg")("note PDF export in Gotenberg", () => {
  let config: GotenbergConfig;

  beforeAll(() => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30_000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
  });

  test("validated map and route PNGs survive the Notebook offline PDF pipeline with all source links", async () => {
    // Browser tests prove complete CloudMap captures. This checks the Notebook assembly and real decoder/PDF seam.
    const markdown = `${serializeGeoDocument(fictionalMap())}\n\n${serializeGeoDocument(fictionalRouteMap())}`;
    const blocks = parseNotebookMapBlocks(markdown).blocks;
    const form = new FormData();
    const images = await Promise.all(
      blocks.map(async (block, index) => {
        const data = await sharp({
          create: { width: 520, height: index ? 150 : 186, channels: 3, background: index ? "#cbd5e1" : "#b4d5e0" },
        })
          .png()
          .toBuffer();
        const id = `line-${block.line}`;
        form.set(geoMapSnapshotPart(id), new Blob([data], { type: "image/png" }));
        return { id, fingerprint: await geoMapSnapshotFingerprint(block.document), width: 520, height: index ? 150 : 186 };
      }),
    );
    const revision = await notebookMapRevision(markdown);
    form.set("mapSnapshots", JSON.stringify({ version: 1, revision, images }));
    const assets = await prepareGeoMapSnapshotAssets(form, { revision, maps: images, maxBytes: config.maxHtmlBytes });
    const { html, omissions } = buildNotePdfHtml({
      markdown,
      notebookShortId: "Book01",
      locale: "en",
      publicOrigin: "https://cloud.example.test",
      mapImages: new Map(assets.map((asset) => [Number(asset.id.slice(5)), { src: asset.name, width: asset.width, height: asset.height }])),
    });
    expect(omissions).toEqual([]);
    const { pdf } = await renderHtmlToPdfWithConfig({ html, assets }, config);
    expect((await pdfImages(pdf)).filter((image) => image.type === "image").map(({ width, height }) => [width, height])).toEqual([
      [520, 186],
      [520, 150],
    ]);
    expect(await pdfText(pdf)).toContain("OpenMapTiles");
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw).toContain("https://www.openstreetmap.org/copyright");
    expect(raw).toContain("https://example.org/museum");
  }, 60_000);

  test("unavailable map images export linked pin and route lists with visible sources", async () => {
    const { html, omissions } = buildNotePdfHtml({
      markdown: `${serializeGeoDocument(fictionalMap())}\n\n${serializeGeoDocument(fictionalRouteMap())}`,
      notebookShortId: "Book01",
      locale: "en",
      publicOrigin: "https://cloud.example.test",
    });
    expect(omissions.filter((omission) => omission.kind === "map")).toHaveLength(2);
    const { pdf } = await renderHtmlToPdfWithConfig({ html, title: "Fictional map plan" }, config);
    const text = await pdfText(pdf);
    for (const content of [
      "Münster",
      "Fischerviertel",
      "Museum Ulm",
      "Glacis-Park",
      "Geoapify",
      "OpenStreetMap",
      "Ulm Hbf",
      "Stuttgart Hbf",
      "95 km",
    ])
      expect(text).toContain(content);
    expect(text).not.toContain(":::map");
    const raw = Buffer.from(pdf).toString("latin1");
    expect(raw).toContain("https://example.org/museum");
    expect(raw).toContain("https://cloud.example.test/app/notebooks/Book01/notes/Note01?mode=book");
  }, 60_000);

  test("PDF links use the public Cloud origin while own headings stay PDF destinations", async () => {
    const markdown = [
      ":::query\nsource: notes\ncolumns:\n  - $title\n  - $tags\n:::",
      "# Guide",
      "[Other](note://DEF456) [Heading](note://DEF456#r%C3%A9sum%C3%A9) [File](attach://PDF001)",
      "[Version](/api/notebooks/ABC123/attachments/PDF001/content?v=7&download=1)",
      "[Own](note://SELF01#guide) [Top](note://SELF01) [Missing](note://SELF01#missing)",
      "[Web](https://example.org/path?q=a%2Fb#section)",
    ].join("\n\n");
    const { html } = buildNotePdfHtml({
      markdown,
      notebookShortId: "ABC123",
      noteShortId: "SELF01",
      locale: "en",
      publicOrigin: "https://public.example.test:8443",
      queryResults: new Map([
        [
          1,
          {
            columns: ["$title", "$tags"],
            items: [{ id: "DEF456", title: "Other", href: "/app/notebooks/ABC123/notes/DEF456", values: { $tags: ["Team/News & QA"] } }],
            total: 1,
            limit: 25,
            truncated: false,
            diagnostics: [],
          },
        ],
      ]),
    });
    const raw = Buffer.from((await renderHtmlToPdfWithConfig({ html, title: "Guide" }, config)).pdf).toString("latin1");
    const uris = [...raw.matchAll(/\/URI \(([^)]*)\)/g)].map((match) => match[1]);
    expect(uris).toEqual(
      expect.arrayContaining([
        "https://public.example.test:8443/app/notebooks/ABC123/notes/DEF456?mode=book",
        "https://public.example.test:8443/app/notebooks/ABC123/notes/DEF456?mode=book#heading-resume",
        "https://public.example.test:8443/app/notebooks/ABC123/tags/team%2Fnews%20%26%20qa?mode=book",
        "https://public.example.test:8443/api/notebooks/ABC123/attachments/PDF001/content?v=1",
        "https://public.example.test:8443/api/notebooks/ABC123/attachments/PDF001/content?v=7&download=1",
        "https://example.org/path?q=a%2Fb#section",
      ]),
    );
    expect(uris.some((uri) => !uri?.startsWith("https://"))).toBe(false);
    expect(raw).not.toContain("file://");
    const destinations = [...raw.matchAll(/\/Subtype \/Link\b[^>]*\/Dest \/([^\s>]+)/g)].map((match) => match[1]);
    expect(destinations).toEqual(["heading-guide", "top", "top"]);
  }, 60_000);

  test("Book tables keep short numbers whole and the last column on the page", async () => {
    const description =
      "Fictional order for a wooden storage cabinet. Each panel is carefully packed for delivery. Assembly instructions and spare fittings are included in the shipment.";
    const tokenPrefix = "example.org/";
    const token = tokenPrefix + "b".repeat(120 - tokenPrefix.length);
    const markdown = [
      "| Nr. | Beschreibung | Menge | Preis |",
      "| --- | --- | --- | --- |",
      `| 100 | ${description} | 1 | 19.50 |`,
      `| 110 | ${description} | 2 | 29.50 |`,
      `| 120 | ${description} ${token} | 3 | 39.50 |`,
    ].join("\n");
    const { html } = buildNotePdfHtml({
      markdown,
      notebookShortId: "ABC123",
      publicOrigin: "https://cloud.example.test",
      locale: "de",
      templateId: "document",
    });
    const { pdf } = await renderHtmlToPdfWithConfig({ html, title: "Fictional order" }, config);
    const text = await pdfText(pdf, { layout: true });

    for (const value of ["Nr\\.", "100", "110", "120"]) {
      expect(text).toMatch(new RegExp(`^\\s*${value}\\s{2,}`, "mu"));
    }
    expect(text).not.toMatch(/^\s*(?:10|11|12|0|N|r\.)\s{2,}/mu);
    for (const value of ["Menge", "Preis", "19.50", "29.50", "39.50"]) {
      expect(text).toContain(value);
    }
    const descriptionText = text
      .replace(/^\s*(?:100|110|120)\s{2,}/gmu, "")
      .replace(/\s{2,}[1-3]\s+\d{2}\.50\s*$/gmu, "")
      .replace(/\s/gu, "");
    expect(descriptionText).toContain(token);
  }, 60_000);

  test("every notice kind prints its content without the directive source", async () => {
    const markdown = [
      "# Hiking weekend",
      ...NOTICES.map((kind) => `:::${kind}\nPack the ${kind} checklist.\n:::`),
      "@gear\n:::data\ntent: Two-person\n:::",
      "Pack weight $w = 12$ kg.",
      "```mermaid\ngraph TD; Tent-->Stakes\n```",
    ].join("\n\n");
    for (const templateId of ["document", "report", "compact", undefined] as const) {
      const { html } = buildNotePdfHtml({
        markdown,
        notebookShortId: "ABC123",
        publicOrigin: "https://cloud.example.test",
        locale: "en",
        templateId,
        customCss: templateId ? undefined : "body { font: 10pt sans-serif; }",
      });
      expect(html.match(/<svg class="k2b-callout__icon" aria-hidden="true"/g)).toHaveLength(5);
      const pdf = (await renderHtmlToPdfWithConfig({ html, title: "Hiking weekend" }, config)).pdf;
      const text = await pdfText(pdf);
      expect(text).not.toContain(":::");
      expect(text).toContain("Hiking weekend");
      for (const kind of NOTICES) expect(text).toContain(`Pack the ${kind} checklist.`);
      expect(text).toContain("Two-person");
      expect(text).toMatch(/Pack weight\s*w\s*=\s*12\s*kg\./u);
      expect(text).toContain("Diagram source");
      expect(text).toContain("graph TD; Tent-->Stakes");
      expect(await pdfTitle(pdf)).toBe("Hiking weekend");
    }
  }, 120_000);

  test("a link to the exported note jumps within the PDF, to its heading or to its top", async () => {
    const markdown =
      "# Guide\n\n[Restore steps](note://DEF456#restore) [Missing](note://DEF456#nope) [Top](note://DEF456)\n\n## Restore\n\nDone.";
    const { html } = buildNotePdfHtml({
      markdown,
      notebookShortId: "ABC123",
      publicOrigin: "https://cloud.example.test",
      noteShortId: "DEF456",
      locale: "en",
    });
    const raw = Buffer.from((await renderHtmlToPdfWithConfig({ html, title: "Guide" }, config)).pdf).toString("latin1");
    // Chromium writes link annotations uncompressed; a named destination is a link inside the document.
    const links = raw.match(/\/Subtype \/Link\b[^>]*>/g) ?? [];
    expect(links.map((link) => /\/Dest \/([^\s>]+)/.exec(link)?.[1])).toEqual(["heading-restore", "top", "top"]);
    // Chromium places `#top` at the top edge of the note's only page.
    expect(raw).toMatch(/\/top \[\d+ 0 R \/XYZ 0 [\d.]+ 0\]/);
  }, 60_000);

  test("references print as labelled pills and web links with a printed arrow", async () => {
    const markdown = [
      "# Brand",
      "See [Akzentfarbe](note://DEF456#akzentfarbe) and [Affinity Designer](https://affinity.serif.com).",
      "",
      "[Markenrichtlinien-2026.pdf](attach://PDF001)",
    ].join("\n");
    const references = {
      notes: new Map([["DEF456", "Farbsystem"]]),
      attachments: new Map([["PDF001", { filename: "Markenrichtlinien-2026.pdf", sizeBytes: 4_200_000 }]]),
    };
    for (const templateId of ["document", "report", "compact"] as const) {
      const { html } = buildNotePdfHtml({
        markdown,
        notebookShortId: "ABC123",
        publicOrigin: "https://cloud.example.test",
        locale: "de",
        templateId,
        references,
      });
      const text = await pdfText((await renderHtmlToPdfWithConfig({ html, title: "Brand" }, config)).pdf);
      expect(text).toContain("Farbsystem › Akzentfarbe");
      expect(text).toMatch(/Affinity Designer ?↗/u);
      expect(text).toMatch(/Markenrichtlinien-2026\.pdf\s*4,2 MB/u);
    }
  }, 120_000);

  test("ligatures print like the reader and copy as text", async () => {
    const words = "office, affine, fluffy, finally, ffi, ffl";
    const markdown = [
      "# Office flow -> finally != done",
      `Body: ${words}. Arrows -> <- <-> => <=> and x != y, a <= b, c >= d (c) 2026 ...`,
      "```ts\nconst office = (fluffy) => fluffy !== affine; // -> => != ffi\n```",
    ].join("\n\n");
    // In Gotenberg, Noto Sans (document) and Noto Serif (report body) form f-ligatures.
    for (const templateId of ["document", "report"] as const) {
      const { html } = buildNotePdfHtml({
        markdown,
        notebookShortId: "ABC123",
        publicOrigin: "https://cloud.example.test",
        locale: "en",
        templateId,
      });
      const pdf = (await renderHtmlToPdfWithConfig({ html, title: "Ligatures" }, config)).pdf;
      // The ligature glyphs are really there, so the plain-letter checks below cover them.
      expect(pdfLigatures(pdf)).toEqual(expect.arrayContaining(["ffi", "ffl", "fi", "fl"]));
      const text = await pdfText(pdf);
      expect(text).toContain("Office flow → finally ≠ done");
      expect(text).toContain(`Body: ${words}.`);
      expect(text).toMatch(/Arrows → ← ↔ ⇒ ⇔ and x ≠ y, a ≤ b, c ≥ d © 2026 …/u);
      expect(text).not.toMatch(/[\ufb00-\ufb06\ufffd]/u);
      // Code keeps the typed characters, as in the reader.
      expect(text).toContain("const office = (fluffy) => fluffy !== affine; // -> => != ffi");

      const fonts = await pdfFonts(pdf);
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) expect(font).toMatchObject({ embedded: true, subset: true, unicode: true });
      const names = fonts.map((font) => font.name);
      // Arrows and relations come from DejaVu Sans in body text and headings.
      expect(names).toEqual(expect.arrayContaining(["DejaVuSans", "DejaVuSans-Bold"]));
      // Without the symbol font, Chromium drew arrows with Liberation Sans and composed `≠` from `=` and a slash.
      expect(names.filter((name) => name.startsWith("LiberationSans"))).toEqual([]);
    }
  }, 120_000);
});
