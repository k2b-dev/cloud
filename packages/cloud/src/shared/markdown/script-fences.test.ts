import { describe, expect, test } from "bun:test";
import { markdown } from "../index";
import { renderHelpMarkdown } from ".";

describe("legacy script fences are inert source", () => {
  for (const [name, render] of [
    ["content", markdown.render],
    ["sync", markdown.renderSync],
    ["help", renderHelpMarkdown],
  ] as const) {
    test(`${name} retains visible highlighted source without executable carriers`, () => {
      const source = 'const greeting = "Grüße 👋";\nui.text("<script>bad()</script>").show();';
      const html = render(`\`\`\`script\n${source}\n\`\`\``);
      expect(html).toContain("md-code-block");
      expect(html).toContain("language-script");
      expect(html).toContain("Grüße 👋");
      expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
      expect(html).toContain('<span class="hl-keyword">const</span>');
      expect(html).not.toMatch(/data-script-source|md-script-(?:block|source|output|active)|<script>|class="hidden"/);
    });
    test(`${name} removes manually supplied source carrier attributes`, () => {
      const html = render('<div data-script-source="YWxlcnQoMSk=">Visible fallback</div>');
      expect(html).toContain("Visible fallback");
      expect(html).not.toContain("data-script-source");
    });
  }
});
