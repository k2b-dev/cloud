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
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(BookSurface, {
          notebookId: "book01",
          notebookName: "Company handbook",
          selectedNoteId: "note02",
          currentHref: "/app/notebooks/book01/notes/note02",
          canWrite,
          locked,
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
  test("renders a complete article and reading navigation without the editor or inspector", () => {
    const html = render();
    expect(html).toContain("Our handbook.");
    expect(html).toContain('class="notebook-book-content"');
    expect(html).toContain("Getting started");
    expect(html).toContain("/app/notebooks/book01/notes/note02?mode=book");
    expect(html).toContain("/app/notebooks/book01/tags/handbook?mode=book");
    expect(html).not.toMatch(/CodeMirror|NoteEditor|NotebookDetailPanel|EditorToolbar|mode=write|mode=readonly/);
    expect(html).toContain("sidebar-mobile");
    expect(html).toContain("sidebar-desktop");
  });
  test("authors can switch views, with Write omitted for locked notes", () => {
    expect(render(true)).toContain("mode=write");
    expect(render(true)).toContain("mode=readonly");
    expect(render(true, true)).not.toContain("mode=write");
    expect(render(true, true)).toContain("mode=readonly");
  });
  test("localizes controls and empty states without leaking editor data", () => {
    expect(bookMessages.check()).toEqual([]);
    expect(render(true, false, "de-CH")).toContain("Bearbeiten");
    expect(render(false, false, "de", null)).toContain("Wähle eine Seite");
    expect(render(false, false, "de")).not.toContain("yjsSnapshot");
  });
});
