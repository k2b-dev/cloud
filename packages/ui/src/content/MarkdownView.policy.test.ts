import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(join(tmpdir(), "kit-markdown-policy-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { renderSafeMarkdown } = await import("./MarkdownView");

test("Markdown resource policy suppresses images and limits link navigation without changing defaults", () => {
  const source = "![Receipt](https://example.com/pixel) [FTP](ftp://example.com/file) [Web](https://example.com) <img src=x>";
  const ordinary = renderSafeMarkdown(source);
  expect(ordinary).toContain('<img src="https://example.com/pixel"');
  const isolated = renderSafeMarkdown(source, {
    allowImages: false,
    linkProtocols: ["https:", "http:", "mailto:"],
    linkTarget: "_blank",
  });
  expect(isolated).not.toContain("<img");
  expect(isolated).not.toContain('href="ftp:');
  expect(isolated).toContain("Receipt");
  expect(isolated).toContain('target="_blank" rel="noopener noreferrer"');
  expect(isolated).toContain("&lt;img");
});

test("text after an inline pre, code, kbd or script tag stays escaped", () => {
  for (const tag of ["pre", "code", "kbd", "script"]) {
    const html = renderSafeMarkdown(
      `x <${tag}> <svg/onload=alert(1)> <a/href=javascript:alert(1)>link &amp; "q"\n\n<img/src=x/onerror=alert(1)> next`,
    );
    expect(html).toContain(`&lt;${tag}&gt; &lt;svg/onload=alert(1)&gt; &lt;a/href=javascript:alert(1)&gt;link &amp; &quot;q&quot;`);
    expect(html).toContain("&lt;img/src=x/onerror=alert(1)&gt; next");
    expect(html.replace(/<\/?p>/g, "")).not.toContain("<");
  }

  const highlighted = renderSafeMarkdown("x <pre> @ada <svg/onload=alert(1)>", { inlineTokens: ["@ada"] });
  expect(highlighted).toContain('<span class="k2b-content-markdown__inline-token">@ada</span> &lt;svg/onload=alert(1)&gt;');
});

test("empty Markdown table headers are omitted while alignment and emphasis survive", () => {
  const html = renderSafeMarkdown("| | |\n| --- | ---: |\n| Tip | **12,30 €** |\n| Total | **135,30 €** |");
  expect(html).not.toContain("<thead>");
  expect(html).not.toContain("<th>");
  expect(html).toContain('class="k2b-content-markdown__table"');
  expect(html).toContain('<td align="right"><strong>12,30 €</strong>');
  expect(html.match(/<tr>/g)).toHaveLength(2);
});

test("partially filled Markdown headers remain semantic headers", () => {
  const html = renderSafeMarkdown("| Name | |\n| --- | ---: |\n| Item | 1 |");
  expect(html).toContain("<thead>");
  expect(html).toContain("<th>Name</th>");
});

test("numeric character references stay escaped text and cannot rebuild markup or URL schemes", () => {
  const html = renderSafeMarkdown(
    "&#60;script&#62;alert(1)&#60;/script&#62; &#x3c;img src=x onerror=alert(1)&#x3e; &#34;quoted&#34; <&#106;avascript:alert(1)> [x](&#106;avascript:alert(1))",
  );
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;");
  expect(html).not.toMatch(/<(?:script|img)\b/i);
  expect(html).not.toMatch(/href="\s*javascript:/i);
});

test("a link label cannot hold another link", () => {
  const html = renderSafeMarkdown("[outer [inner](https://inner.example) text](https://outer.example)");
  expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
  expect(html).toContain('<a href="https://inner.example">inner</a>');
});
