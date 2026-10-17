import { describe, expect, test } from "bun:test";
import { renderMarkdownInfoBlock, renderSafeMarkdown } from "@k2b/ui";
import { sanitizeEmailHtml } from "../email-html";
import { markdown, renderHelpMarkdown, renderMarkdown, renderMarkdownSync } from ".";

const types = ["note", "info", "success", "warning", "danger"] as const;

describe("Markdown info blocks", () => {
  test("every info block is the shared @k2b/ui callout, as in MarkdownView", () => {
    for (const type of types) {
      const source = `:::${type}\nBody\n:::`;
      const html = renderMarkdownSync(source);

      expect(html).toBe(renderMarkdownInfoBlock({ type, bodyHtml: "<p>Body</p>\n" }));
      expect(html).toBe(renderSafeMarkdown(source));
      expect(renderMarkdown(source)).toBe(html);
      expect(renderHelpMarkdown(source)).toBe(html);
    }
  });

  test("the screen-reader type name follows the requested locale", () => {
    expect(renderMarkdownSync(":::warning\nBody\n:::")).toContain('<span class="k2b-sr-only">Warning: </span>');
    expect(renderMarkdownSync(":::warning\nBody\n:::", { locale: "de" })).toContain('<span class="k2b-sr-only">Warnung: </span>');
    expect(renderHelpMarkdown(":::danger\nBody\n:::", { locale: "de" })).toContain('<span class="k2b-sr-only">Gefahr: </span>');
    // Any tag a request may send resolves to the catalog that serves it.
    expect(renderMarkdownSync(":::warning\nBody\n:::", { locale: "de-x-000001" })).toContain('<span class="k2b-sr-only">Warnung: </span>');
    expect(renderMarkdownSync(":::warning\nBody\n:::", { locale: "fr-x-000001" })).toContain('<span class="k2b-sr-only">Warning: </span>');
  });

  test("an explicit title is the visible heading and names the block on its own", () => {
    const html = renderMarkdownSync(":::warning Before <deleting>\nBody\n:::");

    expect(html).toBe(renderMarkdownInfoBlock({ type: "warning", title: "Before <deleting>", bodyHtml: "<p>Body</p>\n" }));
  });

  test("the body is ordinary Markdown with the renderer's own links and sanitization", () => {
    const html = renderMarkdownSync(":::info\nSee [the guide](https://example.com).\n\n- one\n- two\n\n<script>alert(1)</script>\n:::");

    expect(html).toContain('class="k2b-text-link" data-link="web"');
    expect(html).toContain('<li class="custom-list custom-list-bullet">one</li>');
    expect(html).not.toContain("<script");
  });

  test("raw SVG keeps only callout attributes and paths, without executable or foreign SVG markup", () => {
    const html = renderMarkdownSync(
      '<svg viewBox="0 0 2000 2000" width="2000" height="2000" fill="red" aria-hidden="false" class="k2b-callout__icon" style="color:red" href="https://example.com" onload="alert(1)" id="smuggled" data-tone="danger">SVG text<path d="M12 9v4" style="fill:red" href="https://example.com" onclick="alert(2)" class="smuggled"/><circle cx="12" r="10"/><use href="#smuggled"/><a href="https://example.com">SVG link</a><title>SVG name</title><image href="https://example.com/image.png"/><animate attributeName="href"/><g><path d="hidden"/></g><svg><path d="nested"/></svg><foreignObject><script>alert(3)</script></foreignObject></svg>',
    );
    expect(html.trim()).toBe(
      '<p><svg class="k2b-callout__icon" aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path></svg></p>',
    );
  });

  test("KaTeX roots do not broaden the SVG allowlist", () => {
    const html = markdown.renderSync("Die Wurzel $\\sqrt{x}$ steht hier.");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<path");
    expect(html).toContain("steht hier.");
  });

  test("other SVG tags and stray paths are discarded without losing their ordinary content", () => {
    for (const attrs of ["", 'class="fixed inset-0"', 'class="k2b-callout__icon extra"', 'class=" k2b-callout__icon"']) {
      for (const close of ["</svg>", ""]) {
        const html = markdown.renderSync(
          `<svg width="2000" height="2000" ${attrs}><path d="M0 0"/>Inside <strong>bold</strong>${close} After`,
        );
        expect(html).not.toContain("<svg");
        expect(html).not.toContain("<path");
        expect(html).toContain("Inside <strong>bold</strong>");
        expect(html).toContain("After");
      }
    }
    expect(markdown.renderSync('<path d="M0 0"/> After')).not.toContain("<path");
  });

  test("a warning keeps exactly one genuine icon and its paths", () => {
    const html = markdown.renderSync(":::warning\nBody\n:::");
    expect(html.match(/<svg\b/g)).toHaveLength(1);
    expect(html.match(/<path\b/g)).toHaveLength(3);
    expect(html).toContain('<path d="M12 9v4"></path>');
    expect(html).toBe(renderMarkdownInfoBlock({ type: "warning", bodyHtml: "<p>Body</p>\n" }));
  });

  test("email shows a titled block's own words, without the type name", () => {
    const html = sanitizeEmailHtml(
      renderMarkdownSync(":::warning Vor dem Löschen\nDas lässt sich nicht rückgängig machen.\n:::", { links: "plain" }),
    );

    expect(html).toBe("<p>Vor dem Löschen</p><div><p>Das lässt sich nicht rückgängig machen.</p>\n</div>");
  });

  test("Help and plain-link rendering produce the same block", () => {
    const source = ":::info Who can delete\nOnly **managers**.\n:::";
    const expected = renderMarkdownSync(source);

    expect(renderHelpMarkdown(source)).toBe(expected);
    expect(renderMarkdownSync(source, { links: "plain" })).toBe(expected);
  });
});
