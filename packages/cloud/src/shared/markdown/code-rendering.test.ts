import { describe, expect, test } from "bun:test";
import { renderMarkdownSync } from ".";

describe("markdown code blocks", () => {
  test("keeps the in-app code wrapper and language badge", () => {
    const html = renderMarkdownSync("```ts\nconst a = 1;\n```");

    expect(html).toContain('<div class="md-code-block relative my-3">');
    expect(html).toContain('<span class="absolute top-2 right-2 text-xs text-gray-400 dark:text-gray-500 font-mono select-none">ts</span>');
  });

  test("plain output keeps code source in a bare pre without the language label", () => {
    expect(renderMarkdownSync("```ts\nconst a = 1;\n```", { links: "plain" })).toBe("<pre>const a = 1;</pre>\n");
  });

  test("plain output renders an indented code block as a bare pre too", () => {
    expect(renderMarkdownSync("para\n\n    indented\n    code", { links: "plain" })).toBe("<p>para</p>\n<pre>indented\ncode</pre>\n");
  });

  test("plain output keeps Mermaid source without a diagram container", () => {
    expect(renderMarkdownSync("```mermaid\ngraph TD\nA-->B\n```", { links: "plain" })).toBe("<pre>graph TD\nA--&gt;B</pre>\n");
  });
});
