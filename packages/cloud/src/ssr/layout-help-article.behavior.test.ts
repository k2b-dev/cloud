import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("the first paragraph is the short answer; sections and steps leave collapsed details out", async () => {
    const dom = createDomTestHarness();
    try {
      const { helpArticleParts } = await import("./layout-help-article");
      const steps = (count: number) => `<div class="help-steps"><ol class="k2b-steps">${"<li>Step</li>".repeat(count)}</ol></div>`;
      const parts = helpArticleParts(
        `<p>Share a <strong>Space</strong>.</p><h2 id="invite">Invite</h2>${steps(3)}<details><summary>Why</summary><h2 id="aside">Aside</h2>${steps(2)}</details><h2 id="remove">Remove</h2>${steps(2)}`,
      );
      expect(parts.lead).toBe("<p>Share a <strong>Space</strong>.</p>");
      expect(parts.body.startsWith('<h2 id="invite">')).toBe(true);
      expect(parts.sections).toEqual([
        { id: "invite", label: "Invite" },
        { id: "remove", label: "Remove" },
      ]);
      expect(parts.steps).toBe(5);
      // Section labels read like a screen reader: key names, no key caps, icons or decorative separators.
      expect(
        helpArticleParts(
          [
            '<h2 id="press">Press <kbd class="k2b-kbd"><span class="k2b-sr-only">Control K</span><span class="k2b-kbd__keys" aria-hidden="true"><kbd class="k2b-kbd__key">Ctrl</kbd><kbd class="k2b-kbd__key">K</kbd></span></kbd> now</h2>',
            '<h2 id="path"><span class="help-menu-path"><span class="k2b-label-chip"><i class="ti ti-settings" aria-hidden="true"></i>Settings</span><span class="help-menu-path-separator" aria-hidden="true">›</span><span class="k2b-sr-only"> → </span><span class="k2b-label-chip">Sharing</span></span></h2>',
          ].join(""),
        ).sections,
      ).toEqual([
        { id: "press", label: "Press Control K now" },
        { id: "path", label: "Settings → Sharing" },
      ]);
      // A bold-only eyebrow or a heading first means the article has no short answer.
      for (const html of ['<p class="help-eyebrow"><strong>First steps</strong></p><p>Text</p>', '<h2 id="a">A</h2><p>Text</p>'])
        expect(helpArticleParts(html)).toMatchObject({ lead: undefined, body: html });
    } finally {
      dom.cleanup();
    }
  });
}

// The server path never has a DOM. Compare its output with the browser's HTML parser,
// including actual guided Help markup rather than only handcrafted fixtures.
test("server and browser split the same lead, body, spoken sections and task steps", async () => {
  const dom = createDomTestHarness();
  try {
    const { helpArticleParts } = await import("./layout-help-article");
    const { helpArticlePartsServer } = await import("./layout-help-article.server");
    const { renderHelpMarkdown } = await import("../shared/markdown");
    const { defineHelp } = await import("../server/help");
    const source = await Bun.file(new URL("../../../spaces/src/help/documents/en/spaces-sharing.help.md", import.meta.url)).text();
    const article = defineHelp({ documents: [source] }).documents[0];
    if (!article) throw new Error("Missing built-in Help fixture");
    const normalize = (html: string | undefined) => {
      if (html === undefined) return undefined;
      const template = document.createElement("template");
      template.innerHTML = html;
      return template.innerHTML;
    };
    for (const html of [
      '<p>A plain <strong>lead</strong> &amp; answer.</p><h2 id="one">One</h2>',
      '<p class="help-eyebrow"><strong>Start here</strong></p><p>Body</p>',
      '<h2 id="first">Heading first</h2><p>Body</p>',
      " \n<!-- skip me -->\t<p>Leading whitespace.</p>\n<p>Body</p>",
      '<p class="">Empty class is a lead.</p><p>Body</p>',
      '<p>Lead</p><details open><summary>Aside</summary><h2 id="hidden">Hidden</h2><div class="help-steps"><ol><li>Aside step</li></ol></div></details><h2 id="shown">Shown</h2>',
      '<div class="other help-steps"><ol><li>One<ol><li>Nested, not a task step</li></ol></li><li>Two</li></ol></div>',
      '<h2 id="icon"><i aria-hidden="true">Ignore <b>all</b></i>  Spoken \n <span>text &amp; more</span></h2><h2 id="empty"><span aria-hidden="true">Icon</span> </h2>',
      renderHelpMarkdown(article.markdown, { locale: "en", platform: "apple" }),
    ]) {
      const server = helpArticlePartsServer(html);
      const browser = helpArticleParts(html);
      const rebuilt = helpArticleParts((server.lead ?? "") + server.body);
      expect({ ...rebuilt, lead: normalize(rebuilt.lead), body: normalize(rebuilt.body) }).toEqual({
        ...server,
        lead: normalize(server.lead),
        body: normalize(server.body),
      });
      expect({ ...server, lead: normalize(server.lead), body: normalize(server.body) }).toEqual({
        ...browser,
        lead: normalize(browser.lead),
        body: normalize(browser.body),
      });
    }
  } finally {
    dom.cleanup();
  }
});
