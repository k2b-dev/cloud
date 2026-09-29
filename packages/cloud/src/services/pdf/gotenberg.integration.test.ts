import { beforeAll, expect, test } from "bun:test";
import { pdfTitle } from "../../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { type GotenbergConfig, renderFacturXHtmlToPdfWithConfig, renderHtmlToPdfWithConfig } from "./gotenberg";
import { renderMarkdownToPdfWithConfig } from "./markdown";
import { renderTemplatePdfPreview } from "./template-preview";

const TITLE = "Rechnung RE-2026-000042 – Müller & Söhne </title><b>";

suiteFor("gotenberg")("PDF document title in Gotenberg", () => {
  let config: GotenbergConfig;

  beforeAll(() => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30_000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
  });

  const render = async (html: string, title?: string) => pdfTitle((await renderHtmlToPdfWithConfig({ html, title }, config)).pdf);

  test("a caller title names a document without its own title", async () => {
    expect(await render("<!doctype html><html><body><h1>Invoice</h1></body></html>", TITLE)).toBe(TITLE);
    expect(await render("<p>Quirks mode fragment</p>", TITLE)).toBe(TITLE);
    expect(await render("<!doctype html><title> </title><p>Blank title</p>", TITLE)).toBe(TITLE);
    expect(await render('<!doctype html><svg width="8" height="8"><title>Chart</title><rect/></svg>', TITLE)).toBe(TITLE);
    expect(await render("<!doctype html><template><title>Draft</title></template><p>Template</p>", TITLE)).toBe(TITLE);
  }, 60_000);

  test("the document's own title wins over the caller title", async () => {
    expect(await render("<!doctype html><html><head><title>Quarterly report</title></head><body></body></html>", TITLE)).toBe(
      "Quarterly report",
    );
  }, 30_000);

  test("Liquid templates and Markdown carry the caller title", async () => {
    const preview = await renderTemplatePdfPreview(
      { htmlTemplate: "<h1>{{ name }}</h1>", data: { name: "Offer" }, title: TITLE },
      { config },
    );
    if (!preview.ok) throw new Error(preview.error.message);
    expect(await pdfTitle(preview.pdf.pdf)).toBe(TITLE);

    expect(await pdfTitle((await renderMarkdownToPdfWithConfig({ markdown: "# Notes", title: TITLE }, config)).pdf)).toBe(TITLE);
  }, 60_000);

  test("Factur-X invoices carry no title, so viewers show their file name instead of a random one", async () => {
    const invoice = await renderFacturXHtmlToPdfWithConfig(
      {
        html: "<!doctype html><title>Rechnung RE-2026-000042</title><h1>Invoice</h1>",
        xml: '<?xml version="1.0" encoding="UTF-8"?><invoice/>',
      },
      config,
    );
    expect(await pdfTitle(invoice.pdf)).toBeNull();
  }, 60_000);
});
