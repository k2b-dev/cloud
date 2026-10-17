import { expect, test } from "bun:test";
import { LocaleProvider, type NavigationItem } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../../../../tests/fixtures/select-html";
import "../detail/ssr-test-plugin";

const { default: BookNavigator } = await import("./BookNavigator.island");

for (const selectedNoteId of [null, "note01"]) {
  for (const current of [undefined, "graph"] as const) {
    test(`Book Links preserves the origin without a note or while in graph (${selectedNoteId}, ${current})`, async () => {
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
              tree: [],
              tags: [],
              navigationHidden: false,
              currentHref,
              current,
              graphBack,
            });
          },
        }),
      );
      const back = current === "graph" ? graphBack : selectedNoteId ? undefined : currentHref;
      const href = `/app/notebooks/Book01?mode=graph${selectedNoteId ? "&note=note01" : ""}&from=book${back ? `&back=${encodeURIComponent(back)}` : ""}`;
      expect((await selectHtml(html, ".notebook-sidebar-foot a"))[0]?.attributes.href).toBe(href.replaceAll("&", "&amp;"));
      const navigation: { items: NavigationItem[] } = JSON.parse(
        (await selectHtml(html, "script[data-cloud-workspace-navigation]"))[0]!.text,
      );
      expect(navigation.items.find((item) => item.id === "graph")?.href).toBe(href);
    });
  }
}
