import { expect, test } from "bun:test";
import { LocaleProvider, type NavigationItem } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../../../../tests/fixtures/select-html";
import "../detail/ssr-test-plugin";
import { sidebarNote } from "../sidebar/sidebar-tree.test-fixture";

const { default: BookNavigator } = await import("./BookNavigator.island");

for (const selectedNoteId of [null, "note01"]) {
  for (const current of [undefined, "graph"] as const) {
    test(`Book Links returns to the page it opened from, or keeps the graph's return page (${selectedNoteId}, ${current})`, async () => {
      const currentHref = "/app/notebooks/Book01/tags/garden?mode=book";
      const graphBack = "/app/notebooks/Book01/attachments?search=x&page=2";
      const html = renderToString(() =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(BookNavigator, {
              notebookId: "Book01",
              notebookName: "Journal",
              notebookIcon: null,
              selectedNoteId,
              navigation: { total: 0, levels: [{ parentId: null, total: 0, offset: 0, items: [] }], expandedIds: [] },
              tags: [],
              navigationHidden: false,
              currentHref,
              current,
              graphBack,
            });
          },
        }),
      );
      const back = current === "graph" ? graphBack : currentHref;
      const href = `/app/notebooks/Book01?mode=graph${selectedNoteId ? "&note=note01" : ""}&from=book${back ? `&back=${encodeURIComponent(back)}` : ""}`;
      expect((await selectHtml(html, ".notebook-sidebar-foot a"))[0]?.attributes.href).toBe(href.replaceAll("&", "&amp;"));
      const navigation: { items: NavigationItem[] } = JSON.parse(
        (await selectHtml(html, "script[data-cloud-workspace-navigation]"))[0]!.text,
      );
      expect(navigation.items.find((item) => item.id === "graph")?.href).toBe(href);
    });
  }
}

test("a Book level of 5,000 pages renders one page of rows and says how many more there are", async () => {
  const items = Array.from({ length: 100 }, (_, index) => sidebarNote({ id: `N${String(index).padStart(5, "0")}`, title: `Page ${index}` }));
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(BookNavigator, {
          notebookId: "Book01",
          notebookName: "Journal",
          notebookIcon: null,
          selectedNoteId: null,
          navigation: { total: 5000, levels: [{ parentId: null, total: 5000, offset: 0, items }], expandedIds: [] },
          tags: [],
          navigationHidden: false,
          currentHref: "/app/notebooks/Book01?mode=book",
        });
      },
    }),
  );
  expect(await selectHtml(html, '[role="tree"] [role="treeitem"]')).toHaveLength(101);
  expect((await selectHtml(html, '[data-k2b-nav-tree-id="more:"]'))[0]?.text).toContain("4.900 weitere Seiten");
  expect(html.length).toBeLessThan(400_000);
});
