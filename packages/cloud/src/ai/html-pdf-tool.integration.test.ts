import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { type GotenbergTrap, probeDocument, probeTemplate, startGotenbergTrap } from "../../../../scripts/fixtures/gotenberg-trap";
import { pdfTitle } from "../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { GotenbergConfig } from "../services/pdf";
import type { AiFileContent } from "./files-store";
import { createCloudAiHtmlToPdfTool } from "./html-pdf-tool";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const readPdf = async (pdf: Uint8Array) => {
  const loading = getDocument({ data: pdf.slice() });
  const document = await loading.promise;
  try {
    const page = await document.getPage(1);
    const operators = await page.getOperatorList();
    const text = await page.getTextContent();
    return {
      pages: document.numPages,
      size: [page.view[2]! - page.view[0]!, page.view[3]! - page.view[1]!],
      // Intrinsic image sizes: a missing file prints Chromium's broken-image icon instead of the 1x1 PNG.
      images: operators.fnArray.flatMap((operator, index) =>
        operator === OPS.paintImageXObject ? [operators.argsArray[index].slice(1, 3)] : [],
      ),
      text: text.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    };
  } finally {
    await loading.destroy();
  }
};

/** Conversation files in memory; the tool renders through the real platform renderer. */
const convert = async (
  config: GotenbergConfig,
  files: Record<string, { content: string | Uint8Array; mediaType: string }>,
  input: object,
) => {
  const file = (path: string): AiFileContent | null => {
    const stored = files[path];
    if (!stored) return null;
    const bytes = typeof stored.content === "string" ? new TextEncoder().encode(stored.content) : stored.content;
    return {
      path,
      bytes,
      size: bytes.byteLength,
      mediaType: stored.mediaType,
      origin: "assistant",
      updatedAt: new Date().toISOString(),
      version: 1,
    };
  };
  let pdf: Uint8Array | undefined;
  const tool = createCloudAiHtmlToPdfTool({
    stat: async ({ path }) => file(path),
    read: async ({ path }) => file(path),
    write: async (output) => {
      pdf = output.bytes;
    },
    config: async () => config,
  });
  if (tool.location !== "server") throw new Error("Expected server tool");
  const context = {
    actor: { kind: "user", user: { id: "user-1" } },
    conversationId: "conversation-1",
    signal: AbortSignal.timeout(60_000),
  };
  const result = await tool.run(input as never, context as never);
  if (!pdf) throw new Error("The tool wrote no PDF.");
  return { result, pdf };
};

suiteFor("gotenberg")("html_to_pdf in Gotenberg", () => {
  let config: GotenbergConfig;
  let trap: GotenbergTrap;

  beforeAll(() => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30_000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
  });

  beforeEach(async () => {
    trap = await startGotenbergTrap(config.url);
  });

  afterEach(async () => {
    await trap?.stop();
  });

  test("prints CSS, named images, a data: image, a footer, and the page setup", async () => {
    const { result, pdf } = await convert(
      config,
      {
        "/offer/offer.html": {
          content: `<html><head><style>h1 { color: black; }</style></head><body><h1>Quarterly offer</h1><img src="logo.png" width="40" height="40"><img src="seal%232.png" width="40" height="40"><img src="data:image/png;base64,${PNG}" width="40" height="40"></body></html>`,
          mediaType: "text/html",
        },
        "/offer/print.css": { content: 'h1::after { content: " styled by file"; }', mediaType: "text/css" },
        "/offer/footer.html": {
          content: '<html><body><p style="font-size: 10px; margin: 0 15mm">Footer page <span class="pageNumber"></span></p></body></html>',
          mediaType: "text/html",
        },
        "/logo.png": { content: new Uint8Array(Buffer.from(PNG, "base64")), mediaType: "image/png" },
        // A name with a URL-significant character loads through its percent-encoded reference.
        "/uploads/seal#2.png": { content: new Uint8Array(Buffer.from(PNG, "base64")), mediaType: "image/png" },
      },
      {
        path: "/offer/offer.html",
        cssPath: "/offer/print.css",
        customCss: 'body::after { content: "styled inline"; }',
        footerPath: "/offer/footer.html",
        assets: ["/logo.png", "/uploads/seal#2.png"],
        page: { format: "A5", landscape: true, margin: { bottom: 20 } },
      },
    );

    const printed = await readPdf(pdf);
    expect(await trap.takeRequests()).toEqual([]);
    expect(result).toMatchObject({ sourcePath: "/offer/offer.html", path: "/offer/offer.pdf", size: pdf.byteLength });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(printed.pages).toBe(1);
    // A5 landscape; Chromium rounds the paper to whole CSS pixels.
    expect(Math.abs(printed.size[0]! - (210 / 25.4) * 72)).toBeLessThan(1);
    expect(Math.abs(printed.size[1]! - (148 / 25.4) * 72)).toBeLessThan(1);
    expect(printed.text).toContain("Quarterly offer");
    expect(printed.text).toContain("styled by file");
    expect(printed.text).toContain("styled inline");
    expect(printed.text).toContain("Footer page");
    // The HTML has no <title>, so PDF viewers show the source file name.
    expect(await pdfTitle(pdf)).toBe("offer");
    expect(printed.images).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
  }, 60_000);

  test("requests nothing and runs no script from the HTML, CSS, header, or footer", async () => {
    const document = probeDocument(trap.origin, "html-tool");
    const css = `@import url("${trap.origin}/html-tool-css/import"); @font-face { font-family: remote; src: url("${trap.origin}/html-tool-css/font"); } body { font-family: remote; background-image: url("${trap.origin}/html-tool-css/background"); }`;
    const cssPaths = ["/html-tool-css/background", "/html-tool-css/font", "/html-tool-css/import"];

    const unfiltered = await readPdf(await trap.renderUnfiltered({ html: `${document.html}<style>${css}</style>` }));
    expect(await trap.takeRequests()).toEqual(expect.arrayContaining([...document.paths, ...cssPaths]));
    expect(unfiltered.pages).toBe(3);

    const { pdf } = await convert(
      config,
      {
        "/probe.html": { content: document.html, mediaType: "text/html" },
        "/probe.css": { content: css, mediaType: "text/css" },
        "/header.html": { content: probeTemplate(trap.origin, "html-tool-header"), mediaType: "text/html" },
        "/footer.html": { content: probeTemplate(trap.origin, "html-tool-footer"), mediaType: "text/html" },
      },
      { path: "/probe.html", cssPath: "/probe.css", headerPath: "/header.html", footerPath: "/footer.html" },
    );

    expect(await trap.takeRequests()).toEqual([]);
    expect((await readPdf(pdf)).pages).toBe(1);
  }, 60_000);
});
