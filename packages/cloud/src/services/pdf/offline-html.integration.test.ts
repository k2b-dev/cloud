import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  type GotenbergTrap,
  probeCss,
  probeDocument,
  probeNavigation,
  probeTemplate,
  startGotenbergTrap,
} from "../../../../../scripts/fixtures/gotenberg-trap";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { type GotenbergConfig, renderHtmlToPdfWithConfig } from "./gotenberg";
import { buildPresetPdfHtml } from "./markdown";
import { renderTemplatePdfPreview } from "./template-preview";

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
      images: operators.fnArray.filter((operator) => operator === OPS.paintImageXObject).length,
      text: text.items.map((item) => ("str" in item ? item.str : "")).join(" "),
    };
  } finally {
    await loading.destroy();
  }
};

suiteFor("gotenberg")("offline HTML in Gotenberg", () => {
  let trap: GotenbergTrap;
  let config: GotenbergConfig;

  beforeAll(() => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30_000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
  });

  beforeEach(async () => {
    trap = await startGotenbergTrap(config.url);
  });

  afterEach(async () => {
    await trap?.stop();
  });

  test("renderHtmlToPdf requests nothing and runs no script in the document, header, or footer", async () => {
    const document = probeDocument(trap.origin, "html");
    const input = {
      html: document.html,
      headerHtml: probeTemplate(trap.origin, "html-header"),
      footerHtml: probeTemplate(trap.origin, "html-footer"),
    };

    const unfiltered = await readPdf(await trap.renderUnfiltered(input));
    expect(await trap.takeRequests()).toEqual(expect.arrayContaining(document.paths));
    expect(unfiltered.pages).toBe(3);

    const offline = await readPdf((await renderHtmlToPdfWithConfig(input, config)).pdf);
    expect(await trap.takeRequests()).toEqual([]);
    expect(offline.pages).toBe(1);
  }, 60_000);

  test("renderHtmlToPdf keeps the document from navigating away", async () => {
    const navigation = probeNavigation(trap.origin, "navigation");

    await trap.renderUnfiltered({ html: navigation.html });
    expect(await trap.takeRequests()).toContain(navigation.path);

    const offline = await readPdf((await renderHtmlToPdfWithConfig({ html: navigation.html }, config)).pdf);
    expect(await trap.takeRequests()).toEqual([]);
    expect(offline.text).toContain(navigation.text);
  }, 60_000);

  test("Liquid templates render the body, page CSS, header, and footer offline", async () => {
    const document = probeDocument(trap.origin, "template");
    const css = probeCss(trap.origin, "template-css");
    const preview = await renderTemplatePdfPreview(
      {
        htmlTemplate: document.html,
        pageCssTemplate: css.css,
        headerHtmlTemplate: probeTemplate(trap.origin, "template-header"),
        footerHtmlTemplate: probeTemplate(trap.origin, "template-footer"),
        data: {},
      },
      { config },
    );
    if (!preview.ok) throw new Error(preview.error.message);
    expect(await trap.takeRequests()).toEqual([]);
    expect((await readPdf(preview.pdf.pdf)).pages).toBe(1);

    const unfiltered = await readPdf(
      await trap.renderUnfiltered({ html: preview.html, headerHtml: preview.headerHtml, footerHtml: preview.footerHtml }),
    );
    expect(await trap.takeRequests()).toEqual(expect.arrayContaining([...document.paths, ...css.paths]));
    expect(unfiltered.pages).toBe(4);
  }, 60_000);

  test("named assets, stylesheet links, and data URLs keep working", async () => {
    const result = await renderHtmlToPdfWithConfig(
      {
        html: `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><img src="logo.png" width="40" height="40"><img src="data:image/png;base64,${PNG}" width="40" height="40"></body></html>`,
        assets: [
          { name: "styles.css", data: new Blob(['body::after { content: "stylesheet applied"; }'], { type: "text/css" }) },
          { name: "logo.png", data: new Blob([Buffer.from(PNG, "base64")], { type: "image/png" }) },
        ],
      },
      config,
    );

    const pdf = await readPdf(result.pdf);
    expect(await trap.takeRequests()).toEqual([]);
    expect(pdf.text).toContain("stylesheet applied");
    expect(pdf.images).toBe(2);
  }, 60_000);

  test("preset HTML loads named assets and data URLs under the offline policy, not its own", async () => {
    const html = buildPresetPdfHtml({
      html: `<p>Preset</p><img src="logo.png" width="40" height="40"><img src="data:image/png;base64,${PNG}" width="40" height="40">`,
      templateId: "report",
    });
    expect(html).toContain("img-src 'none'");

    const pdf = await readPdf(
      (
        await renderHtmlToPdfWithConfig(
          { html, assets: [{ name: "logo.png", data: new Blob([Buffer.from(PNG, "base64")], { type: "image/png" }) }] },
          config,
        )
      ).pdf,
    );
    expect(await trap.takeRequests()).toEqual([]);
    expect(pdf.text).toContain("Preset");
    expect(pdf.images).toBe(2);
  }, 60_000);
});
