import { describe, expect, test } from "bun:test";
import { renderHelpMarkdown, renderMarkdownSync } from ".";

describe("markdown links", () => {
  test("makes the label and external-link icon one accessible link", () => {
    const html = renderMarkdownSync("[Cloud](https://example.com)");

    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="md-link-widget">');
    expect(html).toContain('<span class="md-link-label">[Cloud]</span>');
    expect(html).toContain('class="md-link-icon ti ti-arrow-up-right text-xs" aria-hidden="true"');
    expect(html).not.toContain('<span class="md-link-widget');
  });

  test("renders plain links as ordinary anchors around their text", () => {
    const html = renderMarkdownSync("See [the **offer**](https://example.com/offer) or write to ada@example.test.", { links: "plain" });

    expect(html).toBe(
      '<p>See <a href="https://example.com/offer">the <strong>offer</strong></a> or write to <a href="mailto:ada@example.test">ada@example.test</a>.</p>\n',
    );
    expect(renderMarkdownSync(":::note\nHi\n:::\n[Cloud](https://example.com)", { notices: "minimal", links: "plain" })).toContain(
      '<a href="https://example.com">Cloud</a>',
    );
    expect(renderMarkdownSync("[Cloud](https://example.com)")).toContain('<span class="md-link-label">[Cloud]</span>');
  });

  test("keeps help links in the current browsing context", () => {
    const html = renderHelpMarkdown("[Next](/docs/next)");

    expect(html).toContain('<a href="/docs/next" class="md-link-widget">');
    expect(html).not.toContain('target="_blank"');
  });
});
