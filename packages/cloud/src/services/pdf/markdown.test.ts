import { describe, expect, test } from "bun:test";
import type { GotenbergConfig } from "./gotenberg";
import {
  buildMarkdownPdfHtml,
  buildPresetPdfHtml,
  MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES,
  MarkdownPdfError,
  renderMarkdownToPdfWithConfig,
} from "./markdown";

const config = {
  url: "http://gotenberg:3000",
  timeoutMs: 5_000,
  maxHtmlBytes: 1024 * 1024,
  maxPdfBytes: 1024 * 1024,
} satisfies GotenbergConfig;

describe("Markdown PDF renderer", () => {
  test("builds standalone CSP-protected preset, layered, and custom documents", () => {
    const html = buildMarkdownPdfHtml({
      markdown: "# Report\n\n| A | B |\n| - | - |\n| 1 | 2 |",
      templateId: "report",
    });
    const layered = buildMarkdownPdfHtml({
      markdown: "# Layered",
      templateId: "report",
      customCss: "h1 { color: rebeccapurple; }",
    });
    const custom = buildMarkdownPdfHtml({ markdown: "# Custom", customCss: "h1 { color: rebeccapurple; }" });

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<main class="markdown-document"><h1>Report</h1>');
    expect(html).toContain("<table>");
    expect(html).toContain("font-family: system-ui");
    expect(layered).toContain("font-family: system-ui");
    expect(layered).toContain("/* Custom CSS overrides */");
    expect(layered).toContain("h1 { color: rebeccapurple; }");
    expect(custom).toContain("h1 { color: rebeccapurple; }");
    expect(custom).not.toContain("margin: 22mm 20mm 24mm");
  });

  test("uses the document preset by default and keeps raw HTML inert", () => {
    const html = buildMarkdownPdfHtml({ markdown: "<script>alert('x')</script>\n\n[unsafe](javascript:alert(1))" });

    expect(html).toContain("margin: 22mm 20mm 24mm");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('href="javascript:');
  });

  test("renders images as safe links without fetching them", () => {
    const html = buildMarkdownPdfHtml({
      markdown: "![Architecture](https://example.test/diagram.png) ![Unsafe](javascript:alert(1))",
    });

    expect(html).toContain('<a href="https://example.test/diagram.png">Image: Architecture</a>');
    expect(html).toContain("Image: Unsafe");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("Please report this to");
  });

  test("rejects empty input, invalid CSS, remote CSS resources, and oversized CSS", () => {
    expect(() => buildMarkdownPdfHtml({ markdown: "  " })).toThrow(MarkdownPdfError);
    expect(() => buildMarkdownPdfHtml({ markdown: "Hello", customCss: "main {" })).toThrow("not valid CSS");
    expect(() => buildMarkdownPdfHtml({ markdown: "Hello", customCss: '@import "https://example.test/style.css";' })).toThrow(
      "cannot load external resources",
    );
    expect(() => buildMarkdownPdfHtml({ markdown: "Hello", customCss: "body { background: url(https://example.test/x); }" })).toThrow(
      "cannot load external resources",
    );
    expect(() =>
      buildMarkdownPdfHtml({
        markdown: "Hello",
        customCss: "a".repeat(MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES + 1),
      }),
    ).toThrow("32 KiB");
  });

  test("keeps custom CSS inside the style element", () => {
    const html = buildMarkdownPdfHtml({ markdown: "Cloud", customCss: "</style><script>alert(1)</script> {}" });

    expect(html).not.toContain("</style><script>");
    expect(html).toContain("\\3c /style><script>");
  });

  test("wraps application HTML in a preset with application CSS before custom CSS", () => {
    const html = buildPresetPdfHtml({
      html: '<aside class="callout">Pack the tent.</aside>',
      templateId: "report",
      css: ".callout { border-left: 4px solid #2563eb; } </style><script>",
      customCss: ".callout { border: 0; }",
    });
    const preset = html.indexOf("margin: 24mm 22mm 26mm");
    const app = html.indexOf(".callout { border-left: 4px solid #2563eb; }");
    const custom = html.indexOf(".callout { border: 0; }");

    expect(html).toContain('<main class="markdown-document"><aside class="callout">Pack the tent.</aside></main>');
    expect(preset).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(preset);
    expect(custom).toBeGreaterThan(app);
    expect(html).not.toContain("</style><script>");

    const customOnly = buildPresetPdfHtml({ html: "<p>Plain</p>", css: ".callout {}", customCss: "p { color: #111; }" });
    expect(customOnly).not.toContain("margin: 22mm 20mm 24mm");
    expect(customOnly).toContain(".callout {}\n/* Custom CSS overrides */\np { color: #111; }");
    expect(() => buildPresetPdfHtml({ html: "<p>x</p>", customCss: "p { background: url(x.png); }" })).toThrow(
      "cannot load external resources",
    );
  });

  test("posts the generated HTML through the existing Gotenberg HTML renderer", async () => {
    let uploaded = "";
    const result = await renderMarkdownToPdfWithConfig({ markdown: "# Rendered", templateId: "compact" }, config, {
      fetch: async (url, init) => {
        expect(String(url)).toBe("http://gotenberg:3000/forms/chromium/convert/html");
        const file = (init?.body as FormData).get("files");
        expect(file).toBeInstanceOf(File);
        uploaded = await (file as File).text();
        return new Response(new TextEncoder().encode("%PDF-test"), { headers: { "content-type": "application/pdf" } });
      },
    });

    expect(uploaded).toStartWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"');
    expect(uploaded).toContain("#f7f7f8");
    expect(uploaded).toContain("<h1>Rendered</h1>");
    expect(new TextDecoder().decode(result.pdf)).toBe("%PDF-test");
  });
});
