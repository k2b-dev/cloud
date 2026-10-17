import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { BOOK_CONTENT_EVENT } from "./book-state";

// The renderer imports @k2b/ui, which needs the DOM harness's window: load it inside the test.
const chart = async (title: string) =>
  (await import("../../../../lib/book-renderer")).renderNotebookBook({
    markdown: `:::chart\ntype: bar\ntitle: ${title}\ncolumns: [Monat, Umsatz]\nrows:\n  - [Januar, 1200]\nx: Monat\ny: Umsatz\n:::`,
    notebookId: "book01",
    locale: "de",
  }).html;
const controls = (root: Element) => Array.from(root.querySelectorAll(".notebook-book-chart__actions button"));
// The island imports the enhancement lazily; wait for its controls instead of a fixed time.
const until = async (ready: () => boolean) => {
  for (let wait = 0; wait < 200 && !ready(); wait++) await Bun.sleep(10);
};

describe("Book chart enhancement", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("the island enhances Book charts, follows page swaps and restores them on disposal", async () => {
    const dom = createDomTestHarness();
    let dispose: (() => void) | undefined;
    try {
      const article = document.createElement("article");
      article.id = "book-charts-probe";
      article.innerHTML = await chart("Erste Seite");
      const host = document.createElement("div");
      dom.root.append(article, host);
      const { default: BookCharts } = await import("./BookCharts.island");
      const { LocaleProvider } = await import("@k2b/ui");
      // The page's locale reaches the island through the shared provider.
      dispose = render(
        () =>
          createComponent(LocaleProvider, {
            locale: "de",
            get children() {
              return createComponent(BookCharts, { rootId: "book-charts-probe" });
            },
          }),
        host,
      );
      await until(() => controls(article).length === 2);
      expect(controls(article).map((button) => button.getAttribute("aria-label"))).toEqual(["Daten kopieren", "Als Tabelle"]);

      // BookController swaps the article's HTML and announces it; the new page's chart gets its own controls.
      const previous = article.querySelector("figure")!;
      article.innerHTML = await chart("Zweite Seite");
      window.dispatchEvent(new CustomEvent(BOOK_CONTENT_EVENT));
      await until(() => controls(article).length === 2);
      expect(article.querySelector(".k2b-chart")?.getAttribute("aria-label")).toBe("Zweite Seite");
      expect(controls(previous)).toHaveLength(0);

      dispose();
      dispose = undefined;
      expect(controls(article)).toHaveLength(0);
      expect(article.querySelector("figure[data-enhanced], [data-interactive]")).toBeNull();
    } finally {
      dispose?.();
      dom.cleanup();
    }
  });
});
