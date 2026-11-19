import { expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { katexHtml, katexSource } from "./katex-parity.test-fixture";

// A browser loads KaTeX only for content with math; the server path (render tests) renders it right away.
if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  test("math shows its source in place until KaTeX arrived, then the same formula the server renders", async () => {
    // `@k2b/ui`'s browser build needs a document when the renderer loads.
    const dom = createDomTestHarness();
    const { markdown } = await import("./index");
    // Text without math never waits for KaTeX.
    expect(markdown.renderSync("Nur Text")).toBe("<p>Nur Text</p>\n");
    const { html, dispose } = createRoot((dispose) => ({ html: createMemo(() => markdown.renderSync(katexSource)), dispose }));
    try {
      expect(html()).toContain('<span class="md-katex-inline"><span class="katex md-katex-pending">E = mc^2</span></span>');
      expect(html()).toContain(
        '<div class="md-katex-block my-3 flex items-center justify-center"><span class="katex-display md-katex-pending"><span class="katex">a^2 + b^2 = c^2</span></span></div>',
      );
      const deadline = performance.now() + 5_000;
      while (html().includes("md-katex-pending") && performance.now() < deadline) await Bun.sleep(10);
      expect(html()).not.toContain("md-katex-pending");
      // The server test checks the same reference without starting a process inside this test's deadline.
      expect(html()).toBe(katexHtml);
      // Once loaded, every later render has the formula right away.
      expect(markdown.renderSync("$x$")).not.toContain("md-katex-pending");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
