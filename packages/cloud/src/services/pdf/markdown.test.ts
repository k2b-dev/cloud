import { describe, expect, test } from "bun:test";
import { renderMarkdownInfoBlock } from "@k2b/ui";
import postcss, { type Rule } from "postcss";
import type { GotenbergConfig } from "./gotenberg";
import {
  buildMarkdownPdfHtml,
  buildPresetPdfHtml,
  MARKDOWN_PDF_MAX_CUSTOM_CSS_BYTES,
  MARKDOWN_PDF_TEMPLATE_IDS,
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
  for (const variant of [...MARKDOWN_PDF_TEMPLATE_IDS, "default", "custom-only"] as const) {
    test(`keeps table cells whole after prose styles and before overrides: ${variant}`, () => {
      const templateId = variant === "default" || variant === "custom-only" ? undefined : variant;
      for (const customCss of variant === "custom-only"
        ? ["th, td { overflow-wrap: normal; }"]
        : [undefined, "th, td { overflow-wrap: normal; }"]) {
        const html = buildPresetPdfHtml({
          html: "<table><tr><td>100</td></tr></table>",
          templateId,
          css: "th, td { word-break: keep-all; }",
          customCss,
        });
        const stylesheet = /<style>([\s\S]*?)<\/style>/u.exec(html)?.[1];
        expect(stylesheet).toBeDefined();
        const rules: Rule[] = [];
        postcss.parse(stylesheet!).walkRules((rule) => {
          rules.push(rule);
        });
        const cellRule = rules.findIndex((rule) => {
          const declarations = Object.fromEntries(rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
          return (
            rule.selectors.join(", ") === "th, td" &&
            declarations["overflow-wrap"] === "break-word" &&
            declarations["word-break"] === "normal"
          );
        });
        expect(cellRule).toBeGreaterThan(-1);
        for (const [index, rule] of rules.entries()) {
          if (rule.selector === ".markdown-document") {
            expect(rule.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ prop: "overflow-wrap", value: "anywhere" })]));
            expect(index).toBeLessThan(cellRule);
          }
          rule.walkDecls((declaration) => {
            if (declaration.value === "keep-all" || (declaration.value === "normal" && declaration.prop === "overflow-wrap")) {
              expect(index).toBeGreaterThan(cellRule);
            }
          });
        }
        // Descendants such as short link/code values must inherit break-word too.
        for (const rule of rules) {
          if (rule.selector !== ".markdown-document" && rule.selector !== "pre") {
            rule.walkDecls("overflow-wrap", (declaration) => {
              expect(declaration.value).not.toBe("anywhere");
            });
          }
        }
      }
    });
  }

  test("adds cell break opportunities every 10 code points in runs over 20 without changing short values or prose", () => {
    const run = "abcdefghijklmnopqrst";
    const long = `${run}${run}z`;
    const broken = "abcdefghij<wbr>klmnopqrst<wbr>abcdefghij<wbr>klmnopqrst<wbr>z";
    const prose = `<h2>${long}</h2>\n<p data-label='unchanged'>${long} &amp;</p><ul><li>${long}</li></ul><pre>${long}</pre>`;
    const html = buildPresetPdfHtml({
      html: `${prose}<table><tr><th>Nr.</th><th>${long}</th></tr><tr><td>100</td><td>${run} ${long}\t${run}\n${run}</td><td><code>limit</code><a href="/${long}">limit</a></td><td><code>${long}</code> <a href="/${long}">${long}</a></td><td>${"😀".repeat(21)}</td></tr></table>`,
    });
    expect(html).toContain(prose);
    expect(html).toContain(`<th>Nr.</th><th>${broken}</th>`);
    expect(html).toContain(`<td>100</td><td>${run} ${broken}\t${run}\n${run}</td>`);
    expect(html).toContain(`<code>limit</code><a href="/${long}">limit</a>`);
    expect(html).toContain(`<code>${broken}</code> <a href="/${long}">${broken}</a>`);
    expect(html).toContain(`<td>${"😀".repeat(10)}<wbr>${"😀".repeat(10)}<wbr>😀</td>`);
  });

  test("counts one run across inline formatting but starts a new run at other elements", () => {
    const a = (count: number) => "a".repeat(count);
    const b = (count: number) => "b".repeat(count);
    const html = buildPresetPdfHtml({
      html: `<table><tr><td>${a(20)}<strong>${b(20)}</strong>${a(20)}</td><td>${a(15)}<em>${b(5)}</em></td><td>${a(15)}<br>${b(15)}<span>${a(15)}</span><wbr>${b(15)}</td><td><span>x</span><span>1</span><span>+</span><span>y</span></td></tr></table>`,
    });
    expect(html).toContain(`<td>${a(20)}<strong><wbr>${b(10)}<wbr>${b(10)}</strong><wbr>${a(10)}<wbr>${a(10)}</td>`);
    expect(html).toContain(`<td>${a(15)}<em>${b(5)}</em></td>`);
    expect(html).toContain(`<td>${a(15)}<br>${b(15)}<span>${a(15)}</span><wbr>${b(15)}</td>`);
    expect(html).toContain("<td><span>x</span><span>1</span><span>+</span><span>y</span></td>");
  });

  test("breaks a long Markdown word made of bold and plain pieces", () => {
    const word = `${"a".repeat(20)}**${"b".repeat(20)}**`.repeat(6);
    const html = buildMarkdownPdfHtml({ markdown: `| Nr. | Wert |\n| --- | --- |\n| 100 | ${word} |` });
    const cell = /<td>(?:(?!<\/td>)[\s\S])*<\/td>\s*<\/tr>\s*<\/tbody>/u.exec(html)?.[0] ?? "";
    expect(cell).toContain("<strong>");
    // 240 units break every 10 from unit 20; the first piece was written before the run grew past 20.
    expect(cell.match(/<wbr>/gu)?.length).toBe(22);
    expect(html).toContain("<td>100</td>");
  });

  test("keeps runs up to 20 units whole and never adds a break at the run end", () => {
    for (const [length, expected] of [
      [10, "a".repeat(10)],
      [20, "a".repeat(20)],
      [21, `${"a".repeat(10)}<wbr>${"a".repeat(10)}<wbr>a`],
      [30, Array(3).fill("a".repeat(10)).join("<wbr>")],
    ] as const) {
      const html = buildPresetPdfHtml({ html: `<table><tr><td>${"a".repeat(length)}</td></tr></table>` });
      expect(html).toContain(`<td>${expected}</td>`);
    }
  });

  test("counts each character reference as one non-whitespace unit without splitting it", () => {
    for (const entity of [
      "&amp;",
      "&#160;",
      "&#xA0;",
      "&nbsp;",
      "&#65",
      "&amp",
      "&#x41",
      "&#X41",
      "&foo",
      "&#00000000065;",
      "&#x0000000041",
    ]) {
      const prefix = "a".repeat(9);
      const html = buildPresetPdfHtml({
        html: `<table><tr><td>${prefix}${entity}${"!".repeat(10)} ${prefix}${entity}${"!".repeat(11)} ${prefix}b${entity}${"!".repeat(10)}</td></tr></table>`,
      });
      expect(html).toContain(
        `<td>${prefix}${entity}${"!".repeat(10)} ${prefix}${entity}<wbr>${"!".repeat(10)}<wbr>! ${prefix}b<wbr>${entity}${"!".repeat(9)}<wbr>!</td>`,
      );
    }
  });

  test("counts an unknown reference-like name as one unit only up to the longest reference name", () => {
    const html = buildPresetPdfHtml({
      html: `<table><tr><td>&CounterClockwiseContourIntegral;</td><td>&${"a".repeat(80)};</td></tr></table>`,
    });
    const a = (count: number) => "a".repeat(count);
    expect(html).toContain("<td>&CounterClockwiseContourIntegral;</td>");
    expect(html).toContain(`<td>&${a(41)}<wbr>${a(10)}<wbr>${a(10)}<wbr>${a(10)}<wbr>${a(9)};</td>`);
  });

  test("never breaks inside a grapheme such as an accented letter or a joined emoji", () => {
    const accent = "e\u0301";
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const html = buildPresetPdfHtml({
      html: `<table><tr><td>${"a".repeat(9)}${accent}${"b".repeat(12)}</td><td>${family.repeat(21)}</td></tr></table>`,
    });
    expect(html).toContain(`<td>${"a".repeat(9)}${accent}<wbr>${"b".repeat(10)}<wbr>${"b".repeat(2)}</td>`);
    expect(html).toContain(`<td>${family.repeat(10)}<wbr>${family.repeat(10)}<wbr>${family}</td>`);
  });

  test("keeps graphemes whole across literal text and character references", () => {
    for (const grapheme of ["e&#x301;", "&#101;\u0301", "&#x1F469;&#x200D;&#x1F4BB;"]) {
      const html = buildPresetPdfHtml({
        html: `<table><tr><td>${"a".repeat(9)}${grapheme}${"b".repeat(12)} ${"c".repeat(21)}</td></tr></table>`,
      });
      expect(html).toContain(
        `<td>${"a".repeat(9)}${grapheme}<wbr>${"b".repeat(10)}<wbr>bb ${"c".repeat(10)}<wbr>${"c".repeat(10)}<wbr>c</td>`,
      );
    }
  });

  test("treats a raw no-break space as part of the run", () => {
    const html = buildPresetPdfHtml({ html: `<table><tr><td>${"a".repeat(10)}\u00a0${"b".repeat(10)}</td></tr></table>` });
    expect(html).toContain(`<td>${"a".repeat(10)}<wbr>\u00a0${"b".repeat(9)}<wbr>b</td>`);
  });

  test("counts a bare ampersand before whitespace as one unit", () => {
    const short = `${"a".repeat(19)}&`;
    const html = buildPresetPdfHtml({ html: `<table><tr><td>${short} ${"b".repeat(21)}</td></tr></table>` });
    expect(html).toContain(`<td>${short} ${"b".repeat(10)}<wbr>${"b".repeat(10)}<wbr>b</td>`);
  });

  test("buffers long cell text across streaming parser chunks", () => {
    const groups = Array.from({ length: 1000 }, () => "abcdefghij");
    const html = buildPresetPdfHtml({ html: `<table><tr><td>${groups.join("")}z</td></tr></table>` });
    expect(html).toContain(`<td>${groups.join("<wbr>")}<wbr>z</td>`);
  });

  test("leaves SVG, MathML, styles and scripts in cells untouched and resumes after self-closing elements", () => {
    const long = "a".repeat(21);
    const skipped = `<svg><g><text>${long}</text></g><svg><text>${long}</text></svg></svg><math><mtext>${long}</mtext></math><style>p { color: ${long}; }</style><script>const x = '${long}';</script><textarea>${long}</textarea><title>${long}</title><svg/><math/>`;
    const html = buildPresetPdfHtml({ html: `<table><tr><td>${skipped}${long}</td><th>${skipped}${long}</th></tr></table>` });
    expect(html).toContain(`<td>${skipped}${"a".repeat(10)}<wbr>${"a".repeat(10)}<wbr>a</td>`);
    expect(html).toContain(`<th>${skipped}${"a".repeat(10)}<wbr>${"a".repeat(10)}<wbr>a</th>`);
  });

  test("treats raw-text elements written as self-closing HTML like their open form", () => {
    // HTML ignores the self-closing flag on non-void HTML elements, so their content stays raw text.
    const long = "a".repeat(34);
    const skipped = `<textarea/>${long}</textarea><title/>${long}</title><style/>p { color: ${long}; }</style>`;
    const html = buildPresetPdfHtml({ html: `<table><tr><td>${skipped}${long}</td></tr></table>` });
    expect(html).toContain(`<td>${skipped}${"a".repeat(10)}<wbr>${"a".repeat(10)}<wbr>${"a".repeat(10)}<wbr>aaaa</td>`);
  });

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

  test("prints callouts with the shared icon markup in every preset", () => {
    for (const templateId of ["document", "report", "compact"] as const) {
      const html = buildMarkdownPdfHtml({ markdown: ":::warning Before printing\nCheck <the> **totals**.\n:::", templateId });

      expect(html).toContain(
        renderMarkdownInfoBlock({
          type: "warning",
          title: "Before printing",
          bodyHtml: "<p>Check &lt;the&gt; <strong>totals</strong>.</p>\n",
        }),
      );
      expect(html).toContain('<svg class="k2b-callout__icon" aria-hidden="true"');
      expect(html).toContain('<path d="M10.363 3.591l-8.106 13.534');
      expect(html).toContain("grid-template-columns: 1.25em minmax(0, 1fr)");
      expect(html).toContain("width: 1.25em; height: 1lh");
      expect(html).toContain("--notice-ink: #92400e");
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
