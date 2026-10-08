import { describe, expect, test } from "bun:test";
import { Marked, type Tokens } from "marked";
import { renderSafeMarkdown } from "./MarkdownView";
import {
  markdownFileType,
  markdownLinkReference,
  markdownReferenceIcon,
  markdownReferenceTypeLabel,
  markStandaloneLinks,
  renderMarkdownLink,
} from "./markdown-links";

const ARROW = '<i class="k2b-text-link__external ti ti-arrow-up-right" aria-hidden="true"></i>';

describe("Markdown link kinds", () => {
  test("a relative URL is a reference: a heading, a page, or a file by its extension", () => {
    expect(markdownLinkReference("#setup")).toEqual({ kind: "heading" });
    expect(markdownLinkReference("/app/spaces/Board1?item=Item01")).toEqual({ kind: "page" });
    expect(markdownLinkReference("docs/next")).toEqual({ kind: "page" });
    expect(markdownLinkReference("/files/Brand%20Guide.pdf?v=2#page=3")).toEqual({ kind: "file", fileName: "Brand Guide.pdf" });
    // A number after the last dot is no extension.
    expect(markdownLinkReference("/releases/2.0")).toEqual({ kind: "page" });
    for (const href of ["https://example.com/a.pdf", "//example.com", "mailto:ada@example.test", "tel:+4930", "note://Abc123"]) {
      expect(markdownLinkReference(href)).toBeNull();
    }
  });

  test("a file's type and icon come from its extension", () => {
    expect(["a.PDF", "b.png", "c.afdesign", "d.psd", "e.fig", "f.zip", "g"].map(markdownFileType)).toEqual([
      "pdf",
      "image",
      "design",
      "design",
      "design",
      "file",
      "file",
    ]);
    expect(markdownReferenceIcon("pdf")).toBe("ti-file-type-pdf");
    expect(markdownReferenceIcon("design")).toBe("ti-vector-bezier-2");
    expect(markdownReferenceIcon("task")).toBe("ti-circle-check");
    // Any other file keeps the glyph of its file family, without the colour.
    expect(markdownReferenceIcon("file", "data.zip")).toBe("ti-file-zip");
  });

  test("type names follow the reader's language", () => {
    const types = ["pdf", "image", "design", "file", "note", "heading", "task", "page"] as const;
    expect(types.map((type) => markdownReferenceTypeLabel(type, "en"))).toEqual([
      "PDF",
      "Image",
      "Design file",
      "File",
      "Note",
      "Heading",
      "Task",
      "Page",
    ]);
    expect(types.map((type) => markdownReferenceTypeLabel(type, "de-DE"))).toEqual([
      "PDF",
      "Bild",
      "Designdatei",
      "Datei",
      "Notiz",
      "Überschrift",
      "Aufgabe",
      "Seite",
    ]);
  });
});

describe("renderMarkdownLink", () => {
  test("a web link is prose text with an arrow; a mail link has none", () => {
    expect(renderMarkdownLink({ href: "https://example.com", html: "Site" })).toBe(
      `<a href="https://example.com" class="k2b-text-link" data-link="web">Site${ARROW}</a>`,
    );
    expect(renderMarkdownLink({ href: "mailto:ada@example.test", html: "Ada", target: "_blank" })).toBe(
      '<a href="mailto:ada@example.test" class="k2b-text-link" data-link="mail" target="_blank" rel="noopener noreferrer">Ada</a>',
    );
    expect(renderMarkdownLink({ href: "https://example.com", html: "Site", rel: "noopener noreferrer" })).toContain(
      'data-link="web" rel="noopener noreferrer">',
    );
  });

  test("a reference is a pill whose accessible name starts with its type", () => {
    expect(renderMarkdownLink({ href: "/f/1", html: "Markenrichtlinien-2026.pdf", reference: { kind: "file" }, locale: "de" })).toBe(
      '<a href="/f/1" class="k2b-reference" data-reference="pdf" aria-label="PDF: Markenrichtlinien-2026.pdf"><i class="k2b-reference__icon ti ti-file-type-pdf" aria-hidden="true"></i>Markenrichtlinien-2026.pdf</a>',
    );
  });

  test("a heading in another document names that document first", () => {
    expect(
      renderMarkdownLink({
        href: "/n/2#accent",
        html: "<em>Akzentfarbe</em>",
        reference: { kind: "heading", document: "Farbsystem" },
        locale: "de",
      }),
    ).toBe(
      '<a href="/n/2#accent" class="k2b-reference" data-reference="heading" aria-label="Überschrift: Farbsystem › Akzentfarbe"><i class="k2b-reference__icon ti ti-hash" aria-hidden="true"></i><span class="k2b-reference__document">Farbsystem ›</span> <em>Akzentfarbe</em></a>',
    );
  });

  test("a file shows its size only when it stands alone on its line", () => {
    const reference = { kind: "file" as const, fileName: "logo.png", size: "860 kB" };
    const inline = renderMarkdownLink({ href: "/f/2", html: "Logo", reference });
    const alone = renderMarkdownLink({ href: "/f/2", html: "Logo", reference, standalone: true });
    expect(inline).not.toContain("860 kB");
    expect(inline).toContain('data-reference="image" aria-label="Image: Logo"');
    expect(alone).toContain('aria-label="Image: Logo, 860 kB"');
    expect(alone).toContain('Logo<span class="k2b-reference__size">860 kB</span></a>');
    // Only files have a size.
    expect(renderMarkdownLink({ href: "/n/1", html: "N", reference: { kind: "note", size: "1 kB" }, standalone: true })).not.toContain(
      "1 kB",
    );
  });

  test("names and titles are escaped attribute values", () => {
    const html = renderMarkdownLink({
      href: '/a"b',
      html: "x&amp;&quot;y",
      title: '"t"',
      reference: { kind: "heading", document: '<b>"Doc"</b>' },
    });
    expect(html).toContain('href="/a&quot;b"');
    expect(html).toContain('aria-label="Heading: &lt;b&gt;&quot;Doc&quot;&lt;/b&gt; › x&amp;&quot;y"');
    expect(html).toContain('title="&quot;t&quot;"');
    expect(html).toContain('<span class="k2b-reference__document">&lt;b&gt;&quot;Doc&quot;&lt;/b&gt; ›</span>');
  });
});

describe("markStandaloneLinks", () => {
  const standalone = (source: string) => {
    const marked = new Marked({ gfm: true, breaks: true });
    const links = new WeakSet<Tokens.Link>();
    const found: string[] = [];
    const tokens = marked.lexer(source);
    marked.walkTokens(tokens, (token) => markStandaloneLinks(token, links));
    marked.walkTokens(tokens, (token) => {
      if (token.type === "link") found.push(`${token.text}:${links.has(token as Tokens.Link)}`);
    });
    return found;
  };

  test("a link alone on a paragraph or list line stands alone; one in a sentence does not", () => {
    expect(standalone("[a](/a)\n[b](/b)  \nsee [c](/c)\n\n- [d](/d)\n- more [e](/e)")).toEqual([
      "a:true",
      "b:true",
      "c:false",
      "d:true",
      "e:false",
    ]);
    expect(standalone("[a](/a) [b](/b)")).toEqual(["a:false", "b:false"]);
  });
});

describe("renderSafeMarkdown links", () => {
  test("references, web and mail links render with their kind, in the render locale", () => {
    const html = renderSafeMarkdown(
      "[Plan.pdf](/files/Plan.pdf), [Board](/app/board), [Top](#top), [Site](https://example.com), ada@example.test",
      {
        locale: "de",
      },
    );
    expect(html).toContain('data-reference="pdf" aria-label="PDF: Plan.pdf"');
    expect(html).toContain('data-reference="page" aria-label="Seite: Board"');
    expect(html).toContain('data-reference="heading" aria-label="Überschrift: Top"');
    expect(html).toContain(`<a href="https://example.com" class="k2b-text-link" data-link="web">Site${ARROW}</a>`);
    expect(html).toContain('<a href="mailto:ada@example.test" class="k2b-text-link" data-link="mail">ada@example.test</a>');
  });

  test("unsafe and disallowed links stay text", () => {
    const html = renderSafeMarkdown("[x](javascript:alert(1)) [y](/relative)", { linkProtocols: ["mailto:"] });
    expect(html).not.toContain("<a ");
  });
});
