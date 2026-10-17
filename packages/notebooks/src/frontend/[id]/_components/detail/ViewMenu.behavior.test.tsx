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
      // Another mode asks the open editor first; a cancelled leave confirmation keeps the page.
      const { SOFT_NOTE_NAVIGATION_REQUEST_EVENT } = await import("../../../lib/soft-navigation");
      const asked: string[] = [];
      let answer: "superseded" | "fallback" = "superseded";
      const editor = (event: Event) => {
        const detail = (event as CustomEvent<{ href: string; handled?: Promise<{ kind: string }> }>).detail;
        asked.push(detail.href);
        detail.handled = Promise.resolve({ kind: answer });
      };
      window.addEventListener(SOFT_NOTE_NAVIGATION_REQUEST_EVENT, editor);
      try {
        choice("Lesen").click();
        await new Promise((done) => setTimeout(done, 0));
        expect(asked).toEqual(["/app/notebooks/Book01/notes/Note01?mode=readonly"]);
        expect(visits).toEqual([]);
        // Confirmed, or no editor to ask: the page opens in the chosen mode.
        answer = "fallback";
        choice("Lesen").click();
        await new Promise((done) => setTimeout(done, 0));
        expect(visits).toEqual(["/app/notebooks/Book01/notes/Note01?mode=readonly"]);
      } finally {
        window.removeEventListener(SOFT_NOTE_NAVIGATION_REQUEST_EVENT, editor);
      }
    } finally {
      dispose();
      dom.cleanup();
    }
  });
