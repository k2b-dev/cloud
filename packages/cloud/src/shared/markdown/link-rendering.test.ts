import { describe, expect, test } from "bun:test";
import { renderHelpMarkdown, renderMarkdownSync } from ".";

describe("markdown links", () => {
  test("a web link is quiet prose text with a small arrow, one accessible link", () => {
    const html = renderMarkdownSync("[Cloud](https://example.com)");

    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toContain(
      '<a href="https://example.com" class="k2b-text-link" data-link="web" target="_blank" rel="noopener noreferrer">Cloud<i class="k2b-text-link__external ti ti-arrow-up-right" aria-hidden="true"></i></a>',
    );
    expect(html).not.toContain("[Cloud]");
  });

  test("a mail link has no arrow, and the link text keeps its formatting", () => {
    const html = renderMarkdownSync("Write to ada@example.test about [the **offer**](https://example.com/offer).");

    expect(html).toContain(
      '<a href="mailto:ada@example.test" class="k2b-text-link" data-link="mail" target="_blank" rel="noopener noreferrer">ada@example.test</a>',
    );
    expect(html).toContain(">the <strong>offer</strong><i ");
  });

  test("a relative link is a reference pill named with its type in the reader's language", () => {
    const html = renderMarkdownSync("Siehe [Vertrag 2026.pdf](/app/files/Vertrag%202026.pdf) und [Board](/app/spaces/Board1).", {
      locale: "de",
    });

    expect(html).toContain(
      '<a href="/app/files/Vertrag%202026.pdf" class="k2b-reference" data-reference="pdf" aria-label="PDF: Vertrag 2026.pdf" target="_blank" rel="noopener noreferrer"><i class="k2b-reference__icon ti ti-file-type-pdf" aria-hidden="true"></i>Vertrag 2026.pdf</a>',
    );
    expect(html).toContain('data-reference="page" aria-label="Seite: Board"');
    expect(html).toContain('<i class="k2b-reference__icon ti ti-link" aria-hidden="true"></i>Board</a>');
  });

  test("renders plain links as ordinary anchors around their text", () => {
    const html = renderMarkdownSync("See [the **offer**](https://example.com/offer) or write to ada@example.test.", { links: "plain" });

    expect(html).toBe(
      '<p>See <a href="https://example.com/offer">the <strong>offer</strong></a> or write to <a href="mailto:ada@example.test">ada@example.test</a>.</p>\n',
    );
    expect(renderMarkdownSync(":::note\nHi\n:::\n[Cloud](https://example.com)", { links: "plain" })).toContain(
      '<a href="https://example.com">Cloud</a>',
    );
  });

  test("a link label cannot hold another link", () => {
    const source = "[outer [inner](https://inner.example) text](https://outer.example)";

    for (const links of ["widget", "plain"] as const) {
      const html = renderMarkdownSync(source, { links });
      expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
      expect(html).toContain('<a href="https://inner.example"');
    }
  });

  test("a raw anchor in a link label stays text, so the label stays one link", () => {
    const html = renderMarkdownSync(
      '[outer <a href="https://attacker.test">click</a> **<a href="https://b.test">x</a>**](https://trusted.test)',
    );

    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toContain(
      'outer &lt;a href="https://attacker.test"&gt;click&lt;/a&gt; <strong>&lt;a href="https://b.test"&gt;x&lt;/a&gt;</strong><i ',
    );
  });

  test("Notebooks note and attachment links render their label as text outside Notebooks", () => {
    const html = renderHelpMarkdown("Open [the plan](note://Abc123#restore) or [Seed order.pdf](attach://pQ45Rt).");

    expect(html).toBe("<p>Open the plan or Seed order.pdf.</p>\n");
  });

  test("numeric character references stay text and cannot rebuild markup or URL schemes", () => {
    const html = renderMarkdownSync(
      "&#60;script&#62;alert(1)&#60;/script&#62; &#x3c;img src=x onerror=alert(1)&#x3e; <&#106;avascript:alert(1)>",
    );

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/<(?:script|img|a)\b/i);
  });

  test("a link label with markup cannot break out of its accessible name", () => {
    const html = renderMarkdownSync('[x" onmouseover="alert(1)](/app/notes/x)');

    expect(html).not.toMatch(/<a\b[^>]*\sonmouseover="/);
    expect(html).toContain('aria-label="Page: x&quot; onmouseover=&quot;alert(1)"');
  });

  test("keeps help links in the current browsing context", () => {
    const html = renderHelpMarkdown("[Next](/docs/next)");

    expect(html).toContain('<a href="/docs/next" class="k2b-reference" data-reference="page" aria-label="Page: Next">');
    expect(html).not.toContain('target="_blank"');
  });
});
