import { describe, expect, test } from "bun:test";
import { NOTICE_CARD_CLASSES, renderMarkdownInfoBlock, renderSafeMarkdown } from "@k2b/ui";
import { sanitizeEmailHtml } from "../email-html";
import { renderHelpMarkdown, renderMarkdownSync } from ".";

const types = ["note", "info", "success", "warning", "danger"] as const;

describe("Markdown info blocks", () => {
  test("every info block is the shared @k2b/ui notice, as in MarkdownView", () => {
    for (const type of types) {
      const source = `:::${type}\nBody\n:::`;
      const html = renderMarkdownSync(source);

      expect(html).toBe(renderMarkdownInfoBlock({ type, bodyHtml: "<p>Body</p>\n" }));
      expect(html).toBe(renderSafeMarkdown(source));
    }
  });

  test("the screen-reader type name follows the requested locale", () => {
    expect(renderMarkdownSync(":::warning\nBody\n:::")).toContain('<span class="k2b-sr-only">Warning: </span>');
    expect(renderMarkdownSync(":::warning\nBody\n:::", { locale: "de" })).toContain('<span class="k2b-sr-only">Warnung: </span>');
    expect(renderHelpMarkdown(":::danger\nBody\n:::", "de")).toContain('<span class="k2b-sr-only">Gefahr: </span>');
  });

  test("an explicit title is the visible heading and names the block on its own", () => {
    const html = renderMarkdownSync(":::warning Before <deleting>\nBody\n:::");

    expect(html).toBe(
      `<aside class="${NOTICE_CARD_CLASSES.root}" data-tone="warning" role="note"><p class="${NOTICE_CARD_CLASSES.title}">Before &lt;deleting&gt;</p><div class="${NOTICE_CARD_CLASSES.body}"><p>Body</p>\n</div></aside>`,
    );
  });

  test("the body is ordinary Markdown with the renderer's own links and sanitization", () => {
    const html = renderMarkdownSync(":::info\nSee [the guide](https://example.com).\n\n- one\n- two\n\n<script>alert(1)</script>\n:::");

    expect(html).toContain('class="md-link-widget"');
    expect(html).toContain('<li class="custom-list custom-list-bullet">one</li>');
    expect(html).not.toContain("<script");
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
