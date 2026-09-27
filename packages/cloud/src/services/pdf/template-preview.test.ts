import { describe, expect, test } from "bun:test";
import type { GotenbergConfig } from "./gotenberg";
import { renderTemplatePdfPreview } from "./template-preview";

const baseConfig = {
  url: "http://gotenberg:3000",
  timeoutMs: 5000,
  maxHtmlBytes: 1024,
  maxPdfBytes: 1024,
} satisfies GotenbergConfig;

const pdfResponse = (body = "%PDF-test") =>
  new Response(new TextEncoder().encode(body), {
    headers: { "content-type": "application/pdf" },
  });

describe("template PDF preview renderer", () => {
  test("renders Liquid data through Gotenberg", async () => {
    const files = new Map<string, string>();
    const result = await renderTemplatePdfPreview(
      {
        htmlTemplate: "<html><head></head><body><p>{{ name }}</p></body></html>",
        headerHtmlTemplate: "<p>{{ title }}</p>",
        footerHtmlTemplate: "<p>{{ document.number }}</p>",
        pageCssTemplate: "@page { margin: 24mm 12mm; }",
        data: { name: "<Ada>", title: "Header", document: { number: "INV-1" } },
      },
      {
        config: baseConfig,
        fetch: async (_url, init) => {
          for (const file of (init?.body as FormData).getAll("files")) {
            if (file instanceof File) files.set(file.name, await file.text());
          }
          return pdfResponse();
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain("<p>&lt;Ada&gt;</p>");
      expect(result.html).toContain("@page { margin: 24mm 12mm; }");
      expect(result.headerHtml).toBe("<p>Header</p>");
      expect(result.footerHtml).toBe("<p>INV-1</p>");
      expect(files.get("index.html")).toContain("<p>&lt;Ada&gt;</p>");
      expect(files.get("header.html")).toEndWith("<p>Header</p>");
      expect(files.get("footer.html")).toEndWith("<p>INV-1</p>");
      expect(result.pdf.contentType).toBe("application/pdf");
      expect(result.pdf.pdf.byteLength).toBeGreaterThan(0);
    }
  });

  test("sends the body, page CSS, header, and footer in offline mode", async () => {
    const files = new Map<string, string>();
    const result = await renderTemplatePdfPreview(
      {
        htmlTemplate: "<p>{{ name }}</p><script>document.title = 'body'</script>",
        headerHtmlTemplate: "<p>Header</p><script>document.title = 'header'</script>",
        footerHtmlTemplate: "<p>Footer</p><script>document.title = 'footer'</script>",
        pageCssTemplate: "</style><script>document.title = 'page css'</script><style>",
        data: { name: "Ada" },
      },
      {
        config: baseConfig,
        fetch: async (_url, init) => {
          for (const file of (init?.body as FormData).getAll("files")) {
            if (file instanceof File) files.set(file.name, await file.text());
          }
          return pdfResponse();
        },
      },
    );

    expect(result.ok).toBe(true);
    expect([...files.keys()]).toEqual(["index.html", "header.html", "footer.html"]);
    for (const html of files.values()) {
      expect(html).toStartWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"');
      expect(html).not.toContain("<script");
    }
    expect(files.get("index.html")).toContain("<p>Ada</p>");
  });

  test("reports Liquid failures as template errors before PDF rendering", async () => {
    let called = false;
    const result = await renderTemplatePdfPreview(
      { htmlTemplate: "{{ missing }}", data: {} },
      {
        config: baseConfig,
        fetch: async () => {
          called = true;
          return pdfResponse();
        },
      },
    );

    expect(called).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { phase: "template", status: 400 } });
  });

  test("reports Gotenberg failures as PDF errors", async () => {
    const result = await renderTemplatePdfPreview(
      { htmlTemplate: "<p>OK</p>", data: {} },
      { config: baseConfig, fetch: async () => new Response("nope", { status: 500 }) },
    );

    expect(result).toMatchObject({ ok: false, error: { phase: "pdf", status: 502, code: "bad_response" } });
  });
});
