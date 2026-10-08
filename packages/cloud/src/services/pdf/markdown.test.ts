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

  test("escapes text after an inline pre, code, kbd or script tag", () => {
    for (const tag of ["pre", "code", "kbd", "script"]) {
      const html = buildMarkdownPdfHtml({
        markdown: `x <${tag}> <svg/onload=alert(1)> <a/href=javascript:alert(1)>link &amp; "q"\n\n<img/src=x/onerror=alert(1)> next`,
      });
      const body = html.slice(html.indexOf("<main"));

      expect(body).toContain(`&lt;${tag}&gt; &lt;svg/onload=alert(1)&gt; &lt;a/href=javascript:alert(1)&gt;link &amp; &quot;q&quot;`);
      expect(body).toContain("&lt;img/src=x/onerror=alert(1)&gt; next");
      expect(body.replace(/<\/?(?:main|p|body|html)\b[^>]*>/g, "")).not.toContain("<");
    }

    expect(buildMarkdownPdfHtml({ markdown: "- item <pre> <svg/onload=alert(1)>" })).toContain(
      "<li>item &lt;pre&gt; &lt;svg/onload=alert(1)&gt;</li>",
    );
  });

  test("keeps numeric character references as escaped text", () => {
    const html = buildMarkdownPdfHtml({
      markdown: "&#60;script&#62;alert(1)&#60;/script&#62; &#x3c;img src=x&#x3e; <&#106;avascript:alert(1)>",
    });
    const body = html.slice(html.indexOf("<main"));

    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x&gt;");
    expect(body).not.toMatch(/<(?:script|img|a)\b/i);
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

  test("prints links as calm text links and reference pills in every preset, without hover", () => {
    for (const templateId of ["document", "report", "compact"] as const) {
      const html = buildMarkdownPdfHtml({
        markdown: "See [the plan](https://example.test/plan), [Offer.pdf](/files/Offer.pdf) and ada@example.test.",
        templateId,
      });

      expect(html).toContain('<a href="https://example.test/plan" class="k2b-text-link" data-link="web">the plan<i ');
      expect(html).toContain(
        '<a href="/files/Offer.pdf" class="k2b-reference" data-reference="pdf" aria-label="PDF: Offer.pdf"><i class="k2b-reference__icon ti ti-file-type-pdf" aria-hidden="true"></i>Offer.pdf</a>',
      );
      expect(html).toContain('<a href="mailto:ada@example.test" class="k2b-text-link" data-link="mail">');
      expect(html).toContain("--link-accent:");
      expect(html).toContain("a.k2b-reference { padding:");
      expect(html).not.toContain(":hover");
    }
  });

  test("prints info blocks as the shared notice in every preset", () => {
    for (const templateId of ["document", "report", "compact"] as const) {
      const html = buildMarkdownPdfHtml({ markdown: ":::warning Before printing\nCheck <the> **totals**.\n:::", templateId });

      expect(html).toContain(
        '<aside class="k2b-notice-card" data-tone="warning" role="note"><p class="k2b-notice-card__title">Before printing</p><div class="k2b-notice-card__body"><p>Check &lt;the&gt; <strong>totals</strong>.</p>',
      );
      expect(html).toContain('.k2b-notice-card[data-tone="warning"] { --notice-tint:');
    }
    expect(buildMarkdownPdfHtml({ markdown: ":::note\nPlain\n:::" })).toContain('<span class="k2b-sr-only">Note: </span>');
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
