import { expect, test } from "bun:test";
import { markdown } from "../../shared";
import { rootResourceLinks } from "./answer-links";

test("roots only exact app/ and open/ href prefixes across multiple anchors", () => {
  const html =
    '<p><a href="app/notebooks/n1/notes/x">Note</a> <a target="_blank" href="open/mail.draft/~x?mode=edit&amp;x=1#body">Draft</a></p>';
  expect(rootResourceLinks(html)).toBe(
    '<p><a href="/app/notebooks/n1/notes/x">Note</a> <a target="_blank" href="/open/mail.draft/~x?mode=edit&amp;x=1#body">Draft</a></p>',
  );
});

test("leaves other hrefs unchanged", () => {
  for (const href of [
    "https://example.com/app/x",
    "http://example.com/open/x",
    "mailto:app/x",
    "/app/x",
    "/open/x",
    "//example.com/app/x",
    "#heading",
    "?x",
    "./app/x",
    "report.md",
    "docs/app/x",
    "App/x",
    "Open/x",
    "note://abc",
    "attach://abc",
  ]) {
    const html = `<a href="${href}">Link</a>`;
    expect(rootResourceLinks(html)).toBe(html);
  }
});

test("leaves text, other attributes, and non-anchor tags unchanged", () => {
  const html =
    '<p>app/x href="app/x"</p><a title="href=&quot;app/x" href="https://e.com">Web</a><a data-href="app/x" href="app/x" title="open/x">Note</a><img src="app/x"><area href="app/x">';
  expect(rootResourceLinks(html)).toBe(html.replace(' href="app/x" title=', ' href="/app/x" title='));
});

test("Markdown sanitization provides double-quoted attributes and escapes quotes and angle brackets", () => {
  const html = markdown.renderSync(`<a title='href="app/x" <tag> & extra' href='app/x'>Note</a>`);
  expect(html).toContain('<a title="href=&quot;app/x&quot; &lt;tag&gt; &amp; extra" href="app/x">');
  expect(rootResourceLinks(html)).toBe(html.replace(' href="app/x"', ' href="/app/x"'));
});
