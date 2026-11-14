import { describe, expect, test } from "bun:test";
import { renderMockups } from "./code-blocks";

describe("code mockup fences", () => {
  test("a tree nests by indentation and keeps notes", () => {
    const html = renderMockups("```tree\ncode/\n  me/  # personal\n    code.ts\n```");
    expect(html).toContain('<figure class="code-mock code-tree">');
    expect(html).toContain(
      '<li data-kind="folder"><span class="code-tree-row"><svg class="code-tree-icon" viewBox="0 0 24 24" aria-hidden="true">',
    );
    expect(html).toMatch(
      /code\/<\/span><\/span><ul><li data-kind="folder">.*me\/<\/span><span class="code-tree-note">personal<\/span><\/span><ul><li data-kind="file">.*code\.ts/,
    );
    expect(html).not.toContain("\n");
  });

  test("a terminal separates commands, notes and output and copies only commands", () => {
    const html = renderMockups("```terminal ~/work\n$ cld code check\n# a note\nPermissions <ok>\n$ cld code test\n```");
    expect(html).toContain(
      '<span class="code-term-line" data-kind="command"><span class="code-term-prompt" aria-hidden="true">$</span> cld code check</span>',
    );
    expect(html).toContain('<span class="code-term-line" data-kind="note"># a note</span>');
    expect(html).toContain('<span class="code-term-line" data-kind="output">Permissions &lt;ok&gt;</span>');
    expect(html).toContain("<span>~/work</span>");
    const encoded = html.match(/data-copy-code="([^"]+)"/)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe("cld code check\ncld code test");
  });

  test("other fences stay Markdown", () => {
    const markdown = "```ts\nconst tree = 1;\n```";
    expect(renderMockups(markdown)).toBe(markdown);
  });
});
