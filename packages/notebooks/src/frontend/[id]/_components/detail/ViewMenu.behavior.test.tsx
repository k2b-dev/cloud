import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

if (isServer) test.skip("runs with browser export conditions", () => {});
else
  test("choosing the mode already shown keeps the page; another mode opens it", async () => {
    const dom = createDomTestHarness();
    const visits: string[] = [];
    const actual = await import("@k2b/ssr/nav");
    mock.module("@k2b/ssr/nav", () => ({ ...actual, navigateTo: (href: string) => visits.push(href) }));
    const { LocaleProvider } = await import("@k2b/ui");
    const { ViewMenu } = await import("./ViewMenu");
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(ViewMenu, {
              mode: "edit",
              notebookId: "Book01",
              noteId: "Note01",
              canEdit: true,
              isRich: true,
              onToggleRich: () => {},
              fullWidth: false,
            });
          },
        }),
      dom.root,
    );
    try {
      const choice = (label: string) =>
        [...dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === label)!;
      expect(["Bearbeiten", "Lesen", "Buch"].map((label) => [choice(label).tagName, choice(label).getAttribute("href")])).toEqual([
        ["A", "/app/notebooks/Book01/notes/Note01?mode=write"],
        ["A", "/app/notebooks/Book01/notes/Note01?mode=readonly"],
        ["A", "/app/notebooks/Book01/notes/Note01?mode=book"],
      ]);
      // The editor and its unsent text stay: no navigation for the current mode.
      choice("Bearbeiten").click();
      expect(visits).toEqual([]);
      choice("Lesen").click();
      expect(visits).toHaveLength(1);
      expect(visits[0]).toContain("/app/notebooks/Book01/notes/Note01");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
