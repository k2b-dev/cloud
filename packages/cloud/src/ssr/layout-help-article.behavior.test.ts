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
      // A bold-only eyebrow or a heading first means the article has no short answer.
      for (const html of ['<p class="help-eyebrow"><strong>First steps</strong></p><p>Text</p>', '<h2 id="a">A</h2><p>Text</p>'])
        expect(helpArticleParts(html)).toMatchObject({ lead: undefined, body: html });
    } finally {
      dom.cleanup();
    }
  });
}
