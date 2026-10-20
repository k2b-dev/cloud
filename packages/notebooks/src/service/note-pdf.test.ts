import { describe, expect, spyOn, test } from "bun:test";
import { createAllowedNetworkFetch, NetworkTargetBlockedError } from "@k2b/cloud/services";
import * as pdfModule from "@k2b/cloud/services/pdf";
import { EMPTY_NETWORK_ALLOWLIST } from "@k2b/cloud/shared";
import { GotenbergRenderError, MarkdownPdfError, PDF_IMAGE_MAX_INPUT_BYTES, type PdfImageVariant } from "@k2b/cloud/services/pdf";
import { renderNotebookBook } from "../lib/book-renderer";
import { notePdfOmissionLabel } from "../lib/pdf-omissions";
import { DOCUMENTED_IMAGE_FORMS } from "../lib/markdown-image.fixtures";
import type { Attachment } from "./attachments";
import { buildNotePdfHtml, notePdfPhaseMs, renderNotePdf } from "./note-pdf";
import { type NotePdfImageDependencies, notePdfImageBoxes, prepareNotePdfImages } from "./note-pdf-images";

const NOTICES = ["note", "info", "success", "warning", "danger"] as const;
const TONES = { note: "neutral", info: "info", success: "success", warning: "warning", danger: "danger" } as const;

const build = (markdown: string, extra: Partial<Parameters<typeof buildNotePdfHtml>[0]> = {}) =>
  buildNotePdfHtml({ markdown, notebookShortId: "ABC123", locale: "en", ...extra }).html;

describe("note PDF HTML", () => {
  test("prints the editor and Book's ordered-label cycle and nested lists", () => {
    const html = build("3. root\n   1. alpha\n      1. roman\n         1. decimal");
    expect(html).toContain("ol ol { list-style-type: lower-alpha; }");
    expect(html).toContain("ol ol ol { list-style-type: lower-roman; }");
    expect(html).toContain("ol ol ol ol { list-style-type: decimal; }");
    expect(html).toContain('<ol start="3">');
    expect(html.match(/<ol(?: [^>]*)?>/g)).toHaveLength(4);
    expect(html).toMatch(/<li>alpha[\s\S]*<ol>[\s\S]*<li>roman/);
    expect(html).toContain(".notebook-book-toc ol { padding-left: 0; list-style: none; }");
  });

  test("renders every notice kind like the reader instead of printing its directive", () => {
    const html = build(["# Trip plan", ...NOTICES.map((kind) => `:::${kind}\nPack the **${kind}** kit.\n:::`)].join("\n\n"), {
      templateId: "report",
    });
    expect(html).not.toContain(":::");
    expect(html.match(/<svg class="k2b-callout__icon" aria-hidden="true"/g)).toHaveLength(5);
    expect(html).toContain('<path d="M10.363 3.591l-8.106 13.534');
    expect(html).toContain('<h1 id="heading-trip-plan">Trip plan</h1>');
    for (const kind of NOTICES) {
      expect(html).toContain(`data-tone="${TONES[kind]}"`);
      expect(html).toContain(`Pack the <strong>${kind}</strong> kit.`);
      expect(html).toContain(`.k2b-notice-card[data-tone="${TONES[kind]}"]`);
    }
    // The body keeps the preset's text colour on a tinted surface without an accent border.
    const notice = /\.k2b-notice-card \{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(notice).toContain("background: var(--notice-tint)");
    expect(notice).not.toContain("border:");
    expect(notice).not.toMatch(/(^|[ ;])color:/);
  });

  test("renders the reader's other note blocks and leaves image slots for preparation", () => {
    const html = build(
      [
        "# Handbook",
        ":::toc\n:::",
        "@profile\n:::data\nowner: Ada\nroles:\n  - ops\n  - docs\n:::",
        ":::query\nsource: notes\n:::",
        "Energy $E = mc^2$ and #team/ops.",
        "![Floor plan](attach://AbC123) ![Logo](https://example.test/logo.png =80x40)",
        "- [x] Booked",
        "```mermaid\ngraph TD; A-->B\n```",
      ].join("\n\n"),
    );
    expect(html).not.toContain(":::");
    expect(html).toContain('<nav class="notebook-book-toc"');
    expect(html).toContain('<dt class="md-data-key">Owner</dt>');
    expect(html).toContain('<span class="md-data-chip">ops</span>');
    expect(html).toContain("This query is unavailable.");
    expect(html).toContain('class="katex"');
    expect(html).toContain(".katex{");
    expect(html).not.toContain("@font-face");
    expect(html).toContain('class="notebook-book-tag"');
    expect(html.match(/IMAGE\d+END/g)).toHaveLength(2);
    expect(html).not.toContain("<img");
    expect(html).toContain('type="checkbox"');
    // Only the reader's browser draws diagrams; the PDF labels their source instead.
    expect(html).toContain('<figcaption>Diagram source</figcaption><pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>');
  });

  test("keeps KaTeX styles out of notes without math and follows the note's locale", () => {
    const html = build(":::warning\n![Karte](attach://AbC123)\n:::", { locale: "de" });
    expect(html).not.toContain(".katex{");
    expect(html).toMatch(/IMAGE\d+END/);
    expect(html).toContain('<span class="k2b-sr-only">Warnung: </span>');
    expect(html).toContain(".k2b-sr-only {");
  });

  test("prints arrow and relation ligatures in one symbol font and keeps the others in the text font", () => {
    const html = build("x -> y <=> z != w (c) 2026 ... 1 -- 2 +- 3", { templateId: "report" });
    expect(html).toContain('<span class="notebook-ligature" title="-&gt;">→</span>');
    expect(html).toContain('<span class="notebook-ligature" title="!=">≠</span>');
    // Zero specificity, so any custom CSS rule for these spans wins.
    const rule = /:where\(([^{}]*)\) \{ font-family: "DejaVu Sans", sans-serif; \}/.exec(html)?.[1] ?? "";
    const selected = [...rule.matchAll(/\.notebook-ligature\[title="([^"]+)"\]/g)].map((match) => match[1]).sort();
    // `©`, `…`, `–` and `±` exist in every text font and keep the preset's typeface.
    expect(selected).toEqual(["!=", "->", "<-", "<->", "<=", "<=>", "=>", ">="].sort());
  });

  test("links to the exported note jump within the PDF; links to other notes keep their address", () => {
    const html = build(
      [
        "# Guide",
        "[Steps](note://DEF456#restore) [Missing](note://DEF456#nope) [Top](note://DEF456) [Other](note://GHI789#restore)",
        "| Link |\n| --- |\n| [Cell](note://DEF456#nope) |",
        "## Restore",
      ].join("\n\n"),
      { noteShortId: "DEF456" },
    );
    expect(html).toContain('<a class="k2b-reference" data-reference="heading" aria-label="Heading: Steps" href="#heading-restore">');
    expect(html).toContain('<h2 id="heading-restore">Restore</h2>');
    // A heading the note does not have opens its top, like the bare link: the PDF has no `#heading-nope` to jump to.
    expect(html.match(/href="#top"/g)).toHaveLength(3);
    expect(html).not.toContain("#heading-nope");
    expect(html).not.toContain("/notes/DEF456");
    expect(html).toContain('href="/app/notebooks/ABC123/notes/GHI789?mode=book#heading-restore"');
  });

  test("layers note styles between the preset and custom CSS", () => {
    const html = build(":::info\nHello\n:::", { templateId: "compact", customCss: ".k2b-notice-card { border: 0; }" });
    const preset = html.indexOf("@page { size: A4; margin: 14mm");
    const notes = html.indexOf('.k2b-notice-card[data-tone="info"]');
    const custom = html.indexOf(".k2b-notice-card { border: 0; }");
    expect(preset).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(preset);
    expect(custom).toBeGreaterThan(notes);

    const customOnly = build(":::info\nHello\n:::", { customCss: "body { color: #111; }" });
    expect(customOnly).not.toContain("@page { size: A4;");
    expect(customOnly).toContain('.k2b-notice-card[data-tone="info"]');
  });

  test("rejects empty notes and invalid custom CSS with the platform's errors", () => {
    expect(() => build("  \n")).toThrow(MarkdownPdfError);
    expect(() => build("Hello", { customCss: "body { background: url(https://example.test/x); }" })).toThrow(
      "Custom CSS cannot load external resources.",
    );
  });
});

test("note PDF includes the chart, data fallback and Cloud light palette", () => {
  const html = build(":::chart\ntype: bar\ntitle: Sales\ncolumns: [Month, Revenue]\nrows:\n  - [Jan, 12]\nx: Month\ny: Revenue\n:::");
  expect(html).toContain('<figure class="notebook-book-chart"');
  expect(html).toContain("<svg");
  expect(html).toContain('<table class="md-table">');
  expect(html).toContain('<span class="md-align-right">12</span>');
  expect(html).toContain(".notebook-book-chart .stdlib-chart");
  expect(html).toContain("--stdlib-chart-c1:#14b8a6");
  expect(html).toContain("--stdlib-chart-c8:#ef4444");
  expect(html).toContain("aspect-ratio: 480 / 280");
});

test("PDF builder returns the renderer's omissions alongside unchanged print HTML", () => {
  const built = buildNotePdfHtml({
    markdown: "![Map](attach://ABC123)\n\n```mermaid\ngraph TD\nA-->B\n```",
    notebookShortId: "ABC123",
    locale: "en",
  });
  expect(built.omissions).toEqual([{ code: "not_rendered", kind: "diagram", label: "graph TD" }]);
  expect(built.images).toHaveLength(1);
  expect(built.html).toContain(built.images[0]!.token);
  expect(built.html).toContain(
    '<figcaption>Diagram source</figcaption><pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>',
  );
  expect(buildNotePdfHtml({ markdown: "# Clean\n\nText.", notebookShortId: "ABC123", locale: "en" }).omissions).toEqual([]);
});

// The packer uses real Book slots and fake encoded bytes, so budget and placement checks share the public HTML seam.

const fixtureAttachment = (shortId: string, extra: Partial<Attachment> = {}): Attachment => ({
  id: shortId,
  shortId,
  notebookId: "notebook",
  filename: `${shortId}.png`,
  mimeType: "image/png",
  sizeBytes: 100,
  kind: "image",
  createdBy: null,
  createdAt: "2026-10-01T00:00:00Z",
  ...extra,
});
const variant = (size: number): PdfImageVariant => ({
  data: new Blob([new Uint8Array(size)]),
  type: "image/jpeg",
  width: 100,
  height: 100,
});
const imageInput = (markdown: string, extra: Partial<Parameters<typeof prepareNotePdfImages>[0]> = {}) => {
  const rendered = renderNotebookBook({ markdown, notebookId: "ABC123", locale: "en", print: true });
  return {
    ...rendered,
    notebookId: "notebook",
    preset: "document" as const,
    maxHtmlBytes: 10000,
    maxAttachmentBytes: 1000,
    deadline: 10000,
    signal: new AbortController().signal,
    locale: "en",
    ...extra,
  };
};
const imageDeps = (extra: Partial<NotePdfImageDependencies> = {}): NotePdfImageDependencies => ({
  fetch: async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }),
  now: () => 100,
  list: async ({ shortIds }) => shortIds.map((id) => fixtureAttachment(id)),
  content: async ({ id }) => ({ ...fixtureAttachment(id), content: new Uint8Array([1]) }),
  prepare: async () => ({ ok: true, variants: [variant(100), variant(70), variant(40)] }),
  ...extra,
});

describe("PDF attachment packing", () => {
  test("does not query missing scanned IDs again and loads only escaped IDs in the second query", async () => {
    const calls: Parameters<NotePdfImageDependencies["list"]>[0][] = [];
    const render = spyOn(pdfModule, "renderHtmlToPdfWithConfig").mockResolvedValue({
      pdf: new Uint8Array(),
      contentType: "application/pdf",
    });
    try {
      const result = await renderNotePdf(
        {
          markdown: "![found](attach://ABC123) ![missing](attach://ZZZZZZ) ![escaped](attach\\://DEF456)",
          notebookId: "notebook",
          notebookShortId: "ABC123",
          noteId: "note",
          userId: null,
          serviceAccountId: null,
          boundNotebookId: null,
          locale: "en",
          title: "Attachment lookup",
        },
        {
          config: { url: "http://gotenberg.invalid", timeoutMs: 1000, maxHtmlBytes: 1024 * 1024, maxPdfBytes: 1024 * 1024 },
          maxAttachmentBytes: 1000,
          imageDependencies: imageDeps({
            list: async (query) => {
              calls.push(query);
              return query.shortIds.filter((id) => id !== "ZZZZZZ").map((id) => fixtureAttachment(id));
            },
          }),
        },
      );
      expect(calls.filter(({ shortIds }) => shortIds.includes("ZZZZZZ"))).toHaveLength(1);
      expect(calls).toEqual([
        { shortIds: ["ABC123", "ZZZZZZ"], notebookId: "notebook" },
        { shortIds: ["DEF456"], notebookId: "notebook" },
      ]);
      expect(result.omissions).toEqual([{ code: "not_found", kind: "image", label: "missing" }]);
      expect(render.mock.calls[0]![0].assets).toHaveLength(2);
    } finally {
      render.mockRestore();
    }
  });

  test("an unconfigured renderer fails before any attachment is listed or prepared", async () => {
    const used: string[] = [];
    const rejected = renderNotePdf(
      {
        markdown: "![photo](attach://ABC123)",
        notebookId: "notebook",
        notebookShortId: "ABC123",
        noteId: "note",
        userId: null,
        serviceAccountId: null,
        boundNotebookId: null,
        locale: "en",
        title: "No renderer",
      },
      {
        config: { url: " ", timeoutMs: 1000, maxHtmlBytes: 1024 * 1024, maxPdfBytes: 1024 * 1024 },
        maxAttachmentBytes: 1000,
        imageDependencies: imageDeps({
          list: async () => {
            used.push("list");
            return [];
          },
          prepare: async () => {
            used.push("prepare");
            return { ok: false, code: "unreadable" };
          },
        }),
      },
    );
    await expect(rejected).rejects.toMatchObject({ code: "not_configured" });
    expect(used).toEqual([]);
  });

  test("page geometry and largest repeated placement determine all three boxes", async () => {
    const input = imageInput("![small](attach://ABC123 =400x) ![large](attach://ABC123 =600x)");
    expect(notePdfImageBoxes([{ ...input.images[0]!, width: null }], "document")[0]!.width).toBe(2008);
    expect(notePdfImageBoxes([input.images[0]!], "document")[0]!.width).toBe(1250);
    // Book keeps `height: auto` when a width is set, so `=400x10` still shows 400 px wide at the image's own ratio.
    expect(notePdfImageBoxes([{ ...input.images[0]!, height: 10 }], "document")[0]).toEqual({ width: 1250, height: 2965 });
    expect(notePdfImageBoxes([{ ...input.images[0]!, width: null, height: 300 }], "document")[0]).toEqual({ width: 2008, height: 938 });
    expect(notePdfImageBoxes([{ ...input.images[0]!, width: 999999, height: 999999 }], "compact")[0]).toEqual({
      width: 2126,
      height: 3154,
    });
    let calls = 0;
    const result = await prepareNotePdfImages(
      input,
      imageDeps({
        prepare: async ({ boxes }) => {
          calls++;
          expect(boxes[0]!.width).toBe(1875);
          return { ok: true, variants: [variant(100), variant(70), variant(40)] };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.assets).toHaveLength(1);
    expect(result.html.match(/src="img-1.jpg"/g)).toHaveLength(2);
    expect(result.omissions).toEqual([]);
  });

  test("the highest fitting tier applies to every image and dead tier variants are released", async () => {
    for (const [sizes, expected] of [
      [[6000, 2000, 1000], 2000],
      [[6000, 6000, 1000], 1000],
      [[2000, 1000, 500], 2000],
    ] as const) {
      const result = await prepareNotePdfImages(
        imageInput("![a](attach://ABC123) ![b](attach://DEF456)"),
        imageDeps({
          prepare: async () => ({ ok: true, variants: sizes.map(variant) }),
        }),
      );
      expect(result.assets.map((asset) => asset.data.size)).toEqual([expected, expected]);
      expect(result.peakRetainedBytes).toBeLessThanOrEqual(3 * 10000);
    }
  });

  test("150 dpi keeps a prefix, skips later workers and merges omissions in document order", async () => {
    const input = imageInput(
      "![a](attach://ABC123)\n\n```mermaid\ngraph TD\n```\n\n![b](attach://DEF456) ![c](attach://GHI789) ![svg](attach://SVG000)",
    );
    let calls = 0;
    const result = await prepareNotePdfImages(
      input,
      imageDeps({
        list: async ({ shortIds }) => shortIds.map((id) => fixtureAttachment(id, id === "SVG000" ? { mimeType: "image/svg+xml" } : {})),
        prepare: async () => {
          calls++;
          return { ok: true, variants: [null, null, variant(6000)] };
        },
      }),
    );
    expect(calls).toBe(2);
    expect(result.assets).toHaveLength(1);
    expect(result.omissions).toEqual([
      { code: "not_rendered", kind: "diagram", label: "graph TD" },
      { code: "over_budget", kind: "image", label: "b" },
      { code: "over_budget", kind: "image", label: "c" },
      { code: "unsupported_format", kind: "image", label: "svg" },
    ]);
    expect(result.peakRetainedBytes).toBe(6000);
  });

  test("foreign and missing IDs are indistinguishable; metadata failures never load content", async () => {
    let loads = 0;
    const result = await prepareNotePdfImages(
      imageInput("![](attach://ABC123) ![](attach://DEF456) ![big](attach://BIG000) ![svg](attach://SVG000)"),
      imageDeps({
        list: async (query) => {
          expect(query.notebookId).toBe("notebook");
          return [
            fixtureAttachment("ABC123", { notebookId: "foreign", filename: "private.png" }),
            fixtureAttachment("BIG000", { sizeBytes: 1001 }),
            fixtureAttachment("SVG000", { mimeType: "image/svg+xml" }),
          ];
        },
        content: async () => {
          loads++;
          return null;
        },
      }),
    );
    expect(loads).toBe(0);
    expect(result.omissions).toEqual([
      { code: "not_found", kind: "image", label: "" },
      { code: "not_found", kind: "image", label: "" },
      { code: "too_large", kind: "image", label: "big" },
      { code: "unsupported_format", kind: "image", label: "svg" },
    ]);
    expect(result.html).not.toContain("private.png");
    expect(result.html).toContain("Image not included – file not found");
  });

  test("attachments above the image worker's input cap are never loaded, even under a larger attachment limit", async () => {
    let loads = 0;
    const result = await prepareNotePdfImages(
      imageInput("![huge](attach://BIG000)", { maxAttachmentBytes: 200 * 1024 * 1024 }),
      imageDeps({
        list: async () => [fixtureAttachment("BIG000", { sizeBytes: PDF_IMAGE_MAX_INPUT_BYTES + 1 })],
        content: async () => {
          loads++;
          return null;
        },
      }),
    );
    expect(loads).toBe(0);
    expect(result.omissions).toEqual([{ code: "too_large", kind: "image", label: "huge" }]);
  });

  test("deadlines and abort stop starting images and propagate primitive failure codes", async () => {
    let now = 100;
    let calls = 0;
    const input = imageInput("![a](attach://ABC123) ![b](attach://DEF456)");
    const result = await prepareNotePdfImages(
      input,
      imageDeps({
        now: () => now,
        prepare: async () => {
          calls++;
          now = 10001;
          return { ok: false, code: "timed_out" };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(result.omissions.map(({ code }) => code)).toEqual(["timed_out", "timed_out"]);
    for (const code of ["unsupported_format", "unreadable", "too_large", "timed_out"] as const) {
      const failure = await prepareNotePdfImages(
        imageInput("![a](attach://ABC123)"),
        imageDeps({ prepare: async () => ({ ok: false, code }) }),
      );
      expect(failure.omissions[0]!.code).toBe(code);
    }
    const controller = new AbortController();
    calls = 0;
    const aborted = await prepareNotePdfImages(
      { ...input, signal: controller.signal },
      imageDeps({
        prepare: async () => {
          calls++;
          controller.abort();
          return { ok: false, code: "timed_out" };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(aborted.omissions.map(({ code }) => code)).toEqual(["timed_out", "timed_out"]);
  });

  test("placeholders are localized, escaped, deduplicated and never change heading IDs", async () => {
    const source =
      "# ![<Floor> & plan](attach://ABC123)\n\n![again](attach://ABC123) ![](https://user:pw@example.test/map.png?secret#fragment) ![x](/api/foo)";
    const input = imageInput(source, { locale: "de" });
    const result = await prepareNotePdfImages(input, imageDeps({ list: async () => [] }));
    expect(result.omissions).toEqual([
      { code: "not_found", kind: "image", label: "<Floor> & plan" },
      { code: "blocked", kind: "image", label: "https://example.test/map.png" },
      { code: "blocked", kind: "image", label: "x" },
    ]);
    expect(result.html).toContain("Bild nicht enthalten: &lt;Floor&gt; &amp; plan – Datei nicht gefunden");
    expect(result.html).toContain(`id="${input.headings[0]!.id}"`);
    expect(input.headings[0]!.text).toBe("<Floor> & plan");
    for (const unsafe of ["attach://", "/api/", "secret", "user:pw", "IMAGE0END"]) expect(result.html).not.toContain(unsafe);
  });

  test("all sized image attributes match Book, including height-only style and titles", async () => {
    for (const fixture of DOCUMENTED_IMAGE_FORMS.filter((fixture) => fixture.href.startsWith("attach://"))) {
      const result = await prepareNotePdfImages(imageInput(fixture.markdown), imageDeps());
      const bookImage = renderNotebookBook({ markdown: fixture.markdown, notebookId: "ABC123", locale: "en" }).html.match(/<img[^>]*>/)![0];
      for (const attribute of ["width", "height", "title"] as const) {
        expect(result.html.match(new RegExp(` ${attribute}="[^"]*"`))?.[0]).toBe(bookImage.match(new RegExp(` ${attribute}="[^"]*"`))?.[0]);
      }
      expect(result.html.includes(`style="height: ${fixture.height}px"`)).toBe(fixture.height !== null && fixture.width === null);
    }
  });

  test("final print HTML loads every image form only from uploaded assets", async () => {
    // Error class: content behind session URLs disappears in server-side exports.
    for (const fixture of DOCUMENTED_IMAGE_FORMS) {
      for (const markdown of [fixture.markdown, `[${fixture.markdown}](https://example.test)`, `# ${fixture.markdown}`]) {
        const result = await prepareNotePdfImages(imageInput(markdown), imageDeps());
        for (const unsafe of ['src="/', 'href="/', "/api/", "/app/", "attach://", "url(/"]) expect(result.html).not.toContain(unsafe);
        const sources = [...result.html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map(([, src]) => src);
        expect(sources).toEqual(["img-1.jpg"]);
      }
    }
  });

  test("HTML alone, including worst-case placeholders, keeps the existing 413 error class", async () => {
    await expect(prepareNotePdfImages(imageInput("![a](attach://ABC123)", { maxHtmlBytes: 10 }), imageDeps())).rejects.toBeInstanceOf(
      GotenbergRenderError,
    );
    await expect(prepareNotePdfImages(imageInput("Text".repeat(100), { maxHtmlBytes: 10 }), imageDeps())).rejects.toMatchObject({
      code: "html_too_large",
    });
    expect(notePdfPhaseMs({ timeoutMs: 120000, url: "", maxHtmlBytes: 1, maxPdfBytes: 1 })).toBe(115000);
  });
});

test("print image styles retain Book proportions and the effective preset's body height", () => {
  for (const [templateId, height] of [
    ["document", 251],
    ["report", 247],
    ["compact", 267],
  ] as const) {
    const built = buildNotePdfHtml({ markdown: "Image", notebookShortId: "ABC123", locale: "en", templateId });
    expect(built.preset).toBe(templateId);
    expect(built.html).toContain(`height: auto; max-height: ${height}mm; object-fit: contain;`);
    expect(built.html).not.toContain("notebook-book-image-label");
  }
  expect(
    buildNotePdfHtml({
      markdown: "Image",
      notebookShortId: "ABC123",
      locale: "en",
      templateId: "compact",
      customCss: "body { color: black; }",
    }).preset,
  ).toBe("compact");
  // Custom CSS alone prints on the document page box, as buildPresetPdfHtml does.
  expect(buildNotePdfHtml({ markdown: "Image", notebookShortId: "ABC123", locale: "en", customCss: "body { color: black; }" }).preset).toBe(
    "document",
  );
});

test("non-web, non-attachment image sources are blocked without fetching or reading bytes", async () => {
  const input = imageInput("![c](/api/x) ![d](img.png) ![e](data:image/png;base64,eA==) ![f](other://host/x) ![g](//host/x)");
  const result = await prepareNotePdfImages(
    input,
    imageDeps({
      fetch: async () => {
        throw new Error("must not fetch");
      },
      content: async () => {
        throw new Error("must not load");
      },
      prepare: async () => {
        throw new Error("must not prepare");
      },
    }),
  );
  expect(result.omissions.map(({ code }) => code)).toEqual(["blocked", "blocked", "blocked", "blocked", "blocked"]);
  expect(result.assets).toEqual([]);
  expect(result.html).not.toContain("src=");
});

// Keep rejected bodies open so cancellation is observable, including before any read.
const externalResponse = (options: { status?: number; headers?: HeadersInit; chunks?: Uint8Array[]; stall?: boolean } = {}) => {
  let cancelled = false;
  let reads = 0;
  const chunks = [...(options.chunks ?? [new Uint8Array([1, 2, 3])])];
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else if (!options.stall) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(stream, { status: options.status ?? 200, headers: options.headers ?? { "content-type": "image/jpeg" } }),
    get cancelled() {
      return cancelled;
    },
    get reads() {
      return reads;
    },
  };
};
const recordingFetch = (reply: (href: string, init: RequestInit, index: number) => Response | Promise<Response>) => {
  const calls: { href: string; init: RequestInit }[] = [];
  const fetch: NotePdfImageDependencies["fetch"] = async (href, init) => {
    calls.push({ href, init });
    return reply(href, init, calls.length - 1);
  };
  return { calls, fetch };
};

describe("external images in note PDFs", () => {
  test("HTTP(S) sources share normalization, sizing and assets, with fresh anonymous headers on every request", async () => {
    const source = externalResponse({ headers: { "content-type": " Image/JPEG ; charset=binary" } });
    const network = recordingFetch(() => source.response);
    let preparations = 0;
    let preparedMaxBytes: number | undefined;
    const input = imageInput("![first](https://images.example.test/a.jpg =100x) ![again](https://images.example.test/a.jpg =600x)");
    const result = await prepareNotePdfImages(
      input,
      imageDeps({
        fetch: network.fetch,
        content: async () => {
          throw new Error("external images must not load attachments");
        },
        prepare: async (image, options) => {
          preparations++;
          expect(image.data).toEqual(new Uint8Array([1, 2, 3]));
          expect(image.boxes).toEqual(notePdfImageBoxes(input.images, "document"));
          preparedMaxBytes = image.maxBytes;
          expect(options?.timeoutMs).toBe(9900);
          return { ok: true, variants: [variant(100), variant(70), variant(40)] };
        },
      }),
    );
    expect(preparedMaxBytes).toBe(Math.min(input.maxHtmlBytes - result.htmlUpperBound, PDF_IMAGE_MAX_INPUT_BYTES));
    expect(preparations).toBe(1);
    expect(network.calls).toHaveLength(1);
    expect(source.cancelled).toBe(false);
    expect(result.assets.map(({ name }) => name)).toEqual(["img-1.jpg"]);
    expect(result.html.match(/src="img-1.jpg"/g)).toHaveLength(2);
    expect(result.omissions).toEqual([]);
    for (const { init } of network.calls) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect([...new Headers(init.headers)]).toEqual([
        ["accept", "image/*"],
        ["user-agent", "Cloud-Notebooks-PDF/1.0"],
      ]);
      for (const header of ["cookie", "authorization", "referer"]) expect(new Headers(init.headers).has(header)).toBe(false);
    }
  });

  test("301 and 302 redirects resolve relative locations, cancel bodies and request each hop separately", async () => {
    const responses = [
      externalResponse({ status: 301, headers: { location: "/next/photo" } }),
      externalResponse({ status: 302, headers: { location: "../final.jpg" } }),
      externalResponse(),
    ];
    const network = recordingFetch((_href, _init, index) => {
      if (index > 0) expect(responses[index - 1]!.cancelled).toBe(true);
      return responses[index]!.response;
    });
    const result = await prepareNotePdfImages(
      imageInput("![photo](http://images.example.test/start)"),
      imageDeps({ fetch: network.fetch }),
    );
    expect(result.assets).toHaveLength(1);
    expect(network.calls.map(({ href }) => href)).toEqual([
      "http://images.example.test/start",
      "http://images.example.test/next/photo",
      "http://images.example.test/final.jpg",
    ]);
    expect(responses.map(({ cancelled }) => cancelled)).toEqual([true, true, false]);
    for (const { init } of network.calls) {
      expect(init.redirect).toBe("manual");
      expect([...new Headers(init.headers)]).toEqual([
        ["accept", "image/*"],
        ["user-agent", "Cloud-Notebooks-PDF/1.0"],
      ]);
    }
    expect(network.calls[0]!.init.headers).not.toBe(network.calls[1]!.init.headers);
  });

  test("redirect targets are revalidated by the helper and the pinned transport", async () => {
    for (const target of ["http://127.0.0.1/x", "file:///etc/passwd", "https://user:pw@images.example.test/x"]) {
      const redirect = externalResponse({ status: 302, headers: { location: target } });
      const network = recordingFetch((href) => {
        if (new URL(href).hostname === "127.0.0.1") throw new NetworkTargetBlockedError("private target");
        return redirect.response;
      });
      const result = await prepareNotePdfImages(
        imageInput("![photo](https://images.example.test/start)"),
        imageDeps({ fetch: network.fetch }),
      );
      expect(result.omissions[0]!.code).toBe("blocked");
      expect(network.calls.map(({ href }) => href)).toEqual(
        target.startsWith("http://127") ? ["https://images.example.test/start", target] : ["https://images.example.test/start"],
      );
      expect(redirect.cancelled).toBe(true);
    }
  });

  test("20 redirects may print, but the 21st redirect response stops without a 22nd request", async () => {
    for (const redirects of [20, 21]) {
      const bodies: ReturnType<typeof externalResponse>[] = [];
      const network = recordingFetch((_href, _init, index) => {
        const body = externalResponse(index < redirects ? { status: 302, headers: { location: `/hop-${index + 1}` } } : {});
        bodies.push(body);
        return body.response;
      });
      const result = await prepareNotePdfImages(
        imageInput("![photo](https://images.example.test/start)"),
        imageDeps({ fetch: network.fetch }),
      );
      expect(network.calls).toHaveLength(21);
      expect(result.omissions.map(({ code }) => code)).toEqual(redirects === 20 ? [] : ["unreachable"]);
      expect(result.assets).toHaveLength(redirects === 20 ? 1 : 0);
      expect(bodies.slice(0, redirects).every(({ cancelled }) => cancelled)).toBe(true);
    }
  });

  test("status, redirect and media-type failures cancel without reading or preparing", async () => {
    for (const [options, code] of [
      [{ status: 404 }, "unreachable"],
      [{ status: 301, headers: {} }, "unreachable"],
      [{ status: 302, headers: { location: "http://[invalid" } }, "unreachable"],
      [{ headers: { "content-type": "text/html" } }, "unsupported_format"],
      [{ headers: { "content-type": " IMAGE/SVG+XML ; charset=utf-8" } }, "unsupported_format"],
      [{ headers: {} }, "unsupported_format"],
    ] as const) {
      const body = externalResponse(options);
      const network = recordingFetch(() => body.response);
      const result = await prepareNotePdfImages(
        imageInput("![photo](https://images.example.test/a)"),
        imageDeps({
          fetch: network.fetch,
          prepare: async () => {
            throw new Error("must not prepare rejected content");
          },
        }),
      );
      expect(result.omissions[0]!.code).toBe(code);
      expect(body.cancelled).toBe(true);
      expect(body.reads).toBe(0);
    }
  });

  test("both length metadata and streamed overflow enforce the input cap and cancel the body", async () => {
    for (const options of [
      { headers: { "content-type": "image/png", "content-length": "1001" } },
      { chunks: [new Uint8Array(600), new Uint8Array(401), new Uint8Array(1)] },
    ]) {
      const body = externalResponse(options);
      const result = await prepareNotePdfImages(
        imageInput("![photo](https://images.example.test/a)"),
        imageDeps({
          fetch: async () => body.response,
          prepare: async () => {
            throw new Error("must not prepare oversized content");
          },
        }),
      );
      expect(result.omissions[0]!.code).toBe("too_large");
      expect(body.cancelled).toBe(true);
      expect(body.reads).toBe(options.headers ? 0 : 2);
    }
    const body = externalResponse({ headers: { "content-type": "image/png", "content-length": String(PDF_IMAGE_MAX_INPUT_BYTES + 1) } });
    const result = await prepareNotePdfImages(
      imageInput("![photo](https://images.example.test/a)", { maxAttachmentBytes: PDF_IMAGE_MAX_INPUT_BYTES * 2 }),
      imageDeps({ fetch: async () => body.response }),
    );
    expect(result.omissions[0]!.code).toBe("too_large");
    expect(body.cancelled).toBe(true);
    expect(body.reads).toBe(0);
  });

  test("generic fetch and read errors, including TypeError, are unreachable", async () => {
    for (const error of [new Error("could not be resolved"), new TypeError("content encoding"), new Error("TLS failure")]) {
      const result = await prepareNotePdfImages(
        imageInput("![photo](https://images.example.test/a)"),
        imageDeps({
          fetch: async () => {
            throw error;
          },
        }),
      );
      expect(result.omissions[0]!.code).toBe("unreachable");
    }
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          throw new Error("read failed");
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, { headers: { "content-type": "image/png" } });
    const reader = stream.getReader();
    const cancel = spyOn(reader, "cancel");
    const getReader = spyOn(stream, "getReader").mockReturnValue(reader);
    try {
      const result = await prepareNotePdfImages(
        imageInput("![photo](https://images.example.test/a)"),
        imageDeps({ fetch: async () => response }),
      );
      expect(result.omissions[0]!.code).toBe("unreachable");
      expect(cancel).toHaveBeenCalled();
    } finally {
      cancel.mockRestore();
      getReader.mockRestore();
    }
  });

  test("a deadline aborts a slow fetch or stalled body, then later images time out without fetching", async () => {
    for (const stallBody of [false, true]) {
      let now = 100;
      const body = externalResponse({ chunks: [], stall: true });
      const network = recordingFetch((_href, init) => {
        const signal = init.signal!;
        signal.addEventListener(
          "abort",
          () => {
            now = 110;
          },
          { once: true },
        );
        if (stallBody) return body.response;
        return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      });
      const result = await prepareNotePdfImages(
        imageInput("![slow](https://images.example.test/slow) ![later](https://images.example.test/later)", { deadline: 110 }),
        imageDeps({ now: () => now, fetch: network.fetch }),
      );
      expect(result.assets).toEqual([]);
      expect(result.omissions.map(({ code }) => code)).toEqual(["timed_out", "timed_out"]);
      expect(network.calls).toHaveLength(1);
      if (stallBody) expect(body.cancelled).toBe(true);
    }
  });

  test("client abort cancels a stalled body and skips subsequent fetches", async () => {
    const controller = new AbortController();
    const body = externalResponse({ chunks: [], stall: true });
    const network = recordingFetch(() => body.response);
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      const result = await prepareNotePdfImages(
        imageInput("![slow](https://images.example.test/a) ![later](https://images.example.test/b)", { signal: controller.signal }),
        imageDeps({ fetch: network.fetch }),
      );
      expect(result.omissions.map(({ code }) => code)).toEqual(["timed_out", "timed_out"]);
      expect(network.calls).toHaveLength(1);
      expect(body.cancelled).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  test("credentials are blocked before fetching and only the redacted address reaches placeholders and reports", async () => {
    for (const locale of ["en", "de"]) {
      const network = recordingFetch(() => {
        throw new Error("must not fetch credentials");
      });
      const result = await prepareNotePdfImages(
        imageInput("![Map](https://user:pw@host/a.png?token=x#f)", { locale }),
        imageDeps({ fetch: network.fetch }),
      );
      expect(network.calls).toEqual([]);
      expect(result.omissions).toEqual([{ code: "blocked", kind: "image", label: "Map (https://host/a.png)" }]);
      expect(result.html).toContain(
        locale === "en"
          ? "Image not included: Map – address not allowed (https://host/a.png)"
          : "Bild nicht enthalten: Map – Adresse nicht erlaubt (https://host/a.png)",
      );
      for (const secret of ["user", "pw", "token", "#f"]) {
        expect(result.html).not.toContain(secret);
        expect(JSON.stringify(result.omissions)).not.toContain(secret);
      }
    }
  });

  test("external sources load and prepare strictly in document order, sharing attachment tiers and the budget precheck", async () => {
    const order: string[] = [];
    const network = recordingFetch((href) => {
      order.push(`fetch:${new URL(href).pathname}`);
      return externalResponse().response;
    });
    const result = await prepareNotePdfImages(
      imageInput(
        "![a](http://images.example.test/a) ![attached](attach://ABC123) ![b](https://images.example.test/b) ![later](https://images.example.test/later)",
      ),
      imageDeps({
        fetch: network.fetch,
        content: async ({ id }) => {
          order.push("content");
          return { ...fixtureAttachment(id), content: new Uint8Array([9]) };
        },
        prepare: async ({ data }) => {
          order.push(data instanceof Uint8Array && data[0] === 9 ? "prepare:attachment" : "prepare:external");
          return { ok: true, variants: [null, null, variant(4000)] };
        },
      }),
    );
    expect(order).toEqual(["fetch:/a", "prepare:external", "content", "prepare:attachment", "fetch:/b", "prepare:external"]);
    expect(network.calls).toHaveLength(2);
    expect(result.assets.map(({ data }) => data.size)).toEqual([4000, 4000]);
    expect(result.omissions.map(({ code }) => code)).toEqual(["over_budget", "over_budget"]);
    expect(result.peakRetainedBytes).toBe(8000);

    const expired = await prepareNotePdfImages(
      imageInput("![expired](https://images.example.test/a)", { deadline: 100 }),
      imageDeps({
        fetch: async () => {
          throw new Error("must not fetch after deadline");
        },
      }),
    );
    expect(expired.omissions[0]!.code).toBe("timed_out");
  });

  test("external placeholders cap alt and redacted URL separately, and every localized result fits its HTML reservation", async () => {
    const url = `https://images.example.test/${"a".repeat(100)}.png`;
    const alt = "😀".repeat(90);
    for (const locale of ["en", "de"]) {
      for (const label of [alt, ""]) {
        const input = imageInput(`![${label}](${url}?secret#fragment)`, { locale });
        for (const code of ["unsupported_format", "unreadable", "too_large", "timed_out"] as const) {
          const result = await prepareNotePdfImages(input, imageDeps({ prepare: async () => ({ ok: false, code }) }));
          expect(result.html).toContain(`(${notePdfOmissionLabel(url)})`);
          if (label) expect(result.html).toContain(notePdfOmissionLabel(label));
          else expect(result.html).toContain(locale === "en" ? "Image not included –" : "Bild nicht enthalten –");
          expect(result.omissions).toEqual([{ kind: "image", code, label: notePdfOmissionLabel(label ? `${label} (${url})` : url) }]);
          expect(new TextEncoder().encode(result.html).byteLength).toBeLessThanOrEqual(result.htmlUpperBound);
          for (const secret of ["secret", "fragment"]) expect(result.html).not.toContain(secret);
        }
      }
    }
  });

  test("a slow external host leaves an omission while renderNotePdf still returns the PDF", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(100);
    const pdf = new Uint8Array([1, 2, 3]);
    const render = spyOn(pdfModule, "renderHtmlToPdfWithConfig").mockResolvedValue({ pdf, contentType: "application/pdf" });
    const network = recordingFetch(
      (_href, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        }),
    );
    try {
      const result = await renderNotePdf(
        {
          markdown: "![slow](https://images.example.test/slow) ![later](https://images.example.test/later)",
          notebookId: "notebook",
          notebookShortId: "ABC123",
          noteId: "note",
          locale: "en",
          title: "Slow host",
          userId: null,
          serviceAccountId: null,
          boundNotebookId: null,
        },
        {
          config: { url: "http://gotenberg.invalid", timeoutMs: 20, maxHtmlBytes: 10000, maxPdfBytes: 10000 },
          maxAttachmentBytes: 1000,
          imageDependencies: imageDeps({ fetch: network.fetch }),
        },
      );
      expect(result.pdf).toEqual(pdf);
      expect(result.omissions.map(({ code }) => code)).toEqual(["timed_out", "timed_out"]);
      expect(network.calls).toHaveLength(1);
      expect(render).toHaveBeenCalledTimes(1);
      expect(render.mock.calls[0]![0].html).toContain(
        "Image not included: slow – preparation took too long (https://images.example.test/slow)",
      );
    } finally {
      render.mockRestore();
      clock.mockRestore();
    }
  });

  test("the real pinned transport blocks loopback and names resolving to private addresses without a network request", async () => {
    const lookups: string[] = [];
    const fetch = createAllowedNetworkFetch(EMPTY_NETWORK_ALLOWLIST, {
      lookup: async (host) => {
        lookups.push(host);
        return [{ address: "10.0.0.5", family: 4 }];
      },
    });
    const result = await prepareNotePdfImages(
      imageInput("![local](http://127.0.0.1/) ![private](https://images.example.test/a)"),
      imageDeps({ fetch }),
    );
    expect(result.omissions.map(({ code }) => code)).toEqual(["blocked", "blocked"]);
    expect(lookups).toEqual(["images.example.test"]);
  });
});
