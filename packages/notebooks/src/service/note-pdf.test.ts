import { describe, expect, test } from "bun:test";
import { MarkdownPdfError } from "@k2b/cloud/services/pdf";
import { buildNotePdfHtml } from "./note-pdf";

const NOTICES = ["note", "info", "success", "warning", "danger"] as const;
const TONES = { note: "neutral", info: "info", success: "success", warning: "warning", danger: "danger" } as const;

const build = (markdown: string, extra: Partial<Parameters<typeof buildNotePdfHtml>[0]> = {}) =>
  buildNotePdfHtml({ markdown, notebookShortId: "ABC123", locale: "en", ...extra });

describe("note PDF HTML", () => {
  test("renders every notice kind like the reader instead of printing its directive", () => {
    const html = build(["# Trip plan", ...NOTICES.map((kind) => `:::${kind}\nPack the **${kind}** kit.\n:::`)].join("\n\n"), {
      templateId: "report",
    });
    expect(html).not.toContain(":::");
    expect(html).toContain('<h1 id="heading-trip-plan">Trip plan</h1>');
    for (const kind of NOTICES) {
      expect(html).toContain(`data-tone="${TONES[kind]}"`);
      expect(html).toContain(`Pack the <strong>${kind}</strong> kit.`);
      expect(html).toContain(`.k2b-notice-card[data-tone="${TONES[kind]}"]`);
    }
    // The calm notice on paper: a light tint, no accent border, and the preset's text colour.
    const notice = /\.k2b-notice-card \{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(notice).toContain("background: var(--notice-tint)");
    expect(notice).not.toContain("border:");
    expect(notice).not.toMatch(/(^|[ ;])color:/);
  });

  test("renders the reader's other note blocks and prints images as labels", () => {
    const html = build(
      [
        "# Handbook",
        ":::toc\n:::",
        "@profile\n:::data\nowner: Ada\nroles:\n  - ops\n  - docs\n:::",
        ":::query\nsource: notes\n:::",
        "Energy $E = mc^2$ and #team/ops.",
        "![Floor plan](attach://AbC123) ![Logo](https://example.test/logo.png =80x40)",
        "- [x] Booked",
        "```mermaid\ngraph TD; A-->B\n```",
      ].join("\n\n"),
    );
    expect(html).not.toContain(":::");
    expect(html).toContain('<nav class="notebook-book-toc"');
    expect(html).toContain('<dt class="md-data-key">Owner</dt>');
    expect(html).toContain('<span class="md-data-chip">ops</span>');
    expect(html).toContain("This query is unavailable.");
    expect(html).toContain('class="katex"');
    expect(html).toContain(".katex{");
    expect(html).not.toContain("@font-face");
    expect(html).toContain('class="notebook-book-tag"');
    expect(html).toContain('<span class="notebook-book-image-label">Image: Floor plan</span>');
    expect(html).toContain('<span class="notebook-book-image-label">Image: Logo</span>');
    expect(html).not.toContain("<img");
    expect(html).toContain('type="checkbox"');
    // Only the reader's browser draws diagrams; the PDF labels their source instead.
    expect(html).toContain('<figcaption>Diagram source</figcaption><pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>');
  });

  test("keeps KaTeX styles out of notes without math and follows the note's locale", () => {
    const html = build(":::warning\n![Karte](attach://AbC123)\n:::", { locale: "de" });
    expect(html).not.toContain(".katex{");
    expect(html).toContain("Bild: Karte");
    expect(html).toContain('<span class="k2b-sr-only">Warnung: </span>');
    expect(html).toContain(".k2b-sr-only {");
  });

  test("prints arrow and relation ligatures in one symbol font and keeps the others in the text font", () => {
    const html = build("x -> y <=> z != w (c) 2026 ... 1 -- 2 +- 3", { templateId: "report" });
    expect(html).toContain('<span class="notebook-ligature" title="-&gt;">→</span>');
    expect(html).toContain('<span class="notebook-ligature" title="!=">≠</span>');
    // Zero specificity, so any custom CSS rule for these spans wins.
    const rule = /:where\(([^{}]*)\) \{ font-family: "DejaVu Sans", sans-serif; \}/.exec(html)?.[1] ?? "";
    const selected = [...rule.matchAll(/\.notebook-ligature\[title="([^"]+)"\]/g)].map((match) => match[1]).sort();
    // `©`, `…`, `–` and `±` exist in every text font and keep the preset's typeface.
    expect(selected).toEqual(["!=", "->", "<-", "<->", "<=", "<=>", "=>", ">="].sort());
  });

  test("links to the exported note jump within the PDF; links to other notes keep their address", () => {
    const html = build(
      [
        "# Guide",
        "[Steps](note://DEF456#restore) [Missing](note://DEF456#nope) [Top](note://DEF456) [Other](note://GHI789#restore)",
        "| Link |\n| --- |\n| [Cell](note://DEF456#nope) |",
        "## Restore",
      ].join("\n\n"),
      { noteShortId: "DEF456" },
    );
    expect(html).toContain('<a class="notebook-book-note-link" href="#heading-restore">');
    expect(html).toContain('<h2 id="heading-restore">Restore</h2>');
    // A heading the note does not have opens its top, like the bare link: the PDF has no `#heading-nope` to jump to.
    expect(html.match(/href="#top"/g)).toHaveLength(3);
    expect(html).not.toContain("#heading-nope");
    expect(html).not.toContain("/notes/DEF456");
    expect(html).toContain('href="/app/notebooks/ABC123/notes/GHI789?mode=book#heading-restore"');
  });

  test("layers note styles between the preset and custom CSS", () => {
    const html = build(":::info\nHello\n:::", { templateId: "compact", customCss: ".k2b-notice-card { border: 0; }" });
    const preset = html.indexOf("@page { size: A4; margin: 14mm");
    const notes = html.indexOf('.k2b-notice-card[data-tone="info"]');
    const custom = html.indexOf(".k2b-notice-card { border: 0; }");
    expect(preset).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(preset);
    expect(custom).toBeGreaterThan(notes);

    const customOnly = build(":::info\nHello\n:::", { customCss: "body { color: #111; }" });
    expect(customOnly).not.toContain("@page { size: A4;");
    expect(customOnly).toContain('.k2b-notice-card[data-tone="info"]');
  });

  test("rejects empty notes and invalid custom CSS with the platform's errors", () => {
    expect(() => build("  \n")).toThrow(MarkdownPdfError);
    expect(() => build("Hello", { customCss: "body { background: url(https://example.test/x); }" })).toThrow(
      "Custom CSS cannot load external resources.",
    );
  });
});
