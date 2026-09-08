import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { bookMessages } from "./messages";
import "../detail/ssr-test-plugin";

const { default: BookSurface } = await import("./BookSurface");

const render = (
  canWrite = false,
  locked = false,
  locale = "en",
  html: string | null = '<h1 id="welcome">Welcome</h1><p>Our handbook.</p>',
  historyIncomplete = false,
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(BookSurface, {
          notebookId: "book01",
          notebookName: "Company handbook",
          selectedNoteId: html === null ? null : "note02",
          currentHref: html === null ? "/app/notebooks/book01" : "/app/notebooks/book01/notes/note02",
          canWrite,
          locked,
          historyIncomplete,
          html,
          noteTitle: "Welcome",
          appUrl: "https://cloud.example.test",
          cursor: null,
          tags: [{ tag: "handbook", count: 2 }],
          tree: [{ id: "note01", title: "Getting started", children: [{ id: "note02", title: "Welcome", children: [] }] }],
        });
      },
    }),
  );

describe("Book surface", () => {
  test("keeps the incomplete-history warning visible to readers", () => {
    const recovered = render(false, false, "en", "<p>Recovered content</p>", true);
    expect(recovered).toContain("Some note changes could not be recovered");
    expect(recovered).toContain('id="notebook-book-history-warning" role="status"');
    expect(render()).toMatch(/id="notebook-book-history-warning" hidden/);
  });
  test("renders a complete article and reading navigation without the editor or inspector", () => {
    const html = render();
    expect(html).toContain("Our handbook.");
    expect(html).toContain('class="notebook-book-shell"');
    expect(html).not.toContain('class="k2b-ui notebook-book-shell"');
    expect(html).toContain('class="notebook-book-content"');
    expect(html).toContain("Getting started");
    expect(html).toContain("/app/notebooks/book01/notes/note02?mode=book");
    expect(html).toContain("/app/notebooks/book01/tags/handbook?mode=book");
    expect(html).not.toMatch(/CodeMirror|NoteEditor|NotebookDetailPanel|EditorToolbar|mode=write|mode=readonly/);
    expect(html).toContain("sidebar-mobile");
    expect(html).toContain("sidebar-desktop");
  });
  test("authors get a floating edit action only on unlocked notes", () => {
    expect(render(true)).toContain("mode=write");
    expect(render(true)).toContain("notebook-floating-edit");
    expect(render(true)).not.toContain("mode=readonly");
    expect(render(true, true)).not.toContain("mode=write");
    expect(render(true, true)).not.toContain("notebook-floating-edit");
    expect(render(true, true)).toContain("/notes/note02?mode=readonly");
  });
  test("authors can leave an empty Book without exposing an edit action to readers", () => {
    const empty = render(true, false, "en", null);
    expect(empty).toContain("/app/notebooks/book01?mode=readonly");
    expect(empty).toContain("Open workspace");
    expect(empty).not.toContain("mode=write");
    expect(render(false, false, "en", null)).not.toContain("Open workspace");
  });
  test("localizes controls and empty states without leaking editor data", () => {
    expect(bookMessages.check()).toEqual([]);
    expect(render(true, false, "de-CH")).toContain("Notiz bearbeiten");
    expect(render(false, false, "de", null)).toContain("Wähle eine Seite");
    expect(render(false, false, "de")).not.toContain("yjsSnapshot");
  });
});
