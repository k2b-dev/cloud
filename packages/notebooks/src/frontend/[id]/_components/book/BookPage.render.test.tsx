import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { WorkspaceLayout } from "@k2b/ui/v2";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../../../../tests/fixtures/select-html";
import { bookNavigationState } from "../sidebar/sidebar-tree.test-fixture";
import { bookMessages } from "./messages";
import "../detail/ssr-test-plugin";

const { default: BookPage } = await import("./BookPage");

const render = (
  canWrite = false,
  locked = false,
  locale = "en",
  html: string | null = '<h1 id="welcome">Welcome</h1><p>Our handbook.</p>',
  historyIncomplete = false,
  selectedNoteId: string | null = html === null ? null : "note02",
  sidebarCollapsed = false,
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(WorkspaceLayout, {
          sidebarCollapsed,
          get children() {
            return createComponent(BookPage, {
              notebookId: "book01",
              notebookName: "Company handbook",
              notebookIcon: null,
              selectedNoteId,
              currentHref: html === null ? "/app/notebooks/book01" : "/app/notebooks/book01/notes/note02",
              canWrite,
              locked,
              historyIncomplete,
              html,
              noteTitle: "Welcome",
              cursor: null,
              now: "2026-10-16T17:30:00.000Z",
              authors: {
                createdBy: { kind: "user", id: "u-ada", displayName: "Ada Renz", avatarHash: null },
                lastEditedBy: { kind: "user", id: "u-lena", displayName: "Lena Hartwig", avatarHash: null },
              },
              updatedAt: "2026-10-16T17:26:00.000Z",
              navigationHidden: false,
              fullWidth: false,
              tags: [{ tag: "handbook", count: 2 }],
              navigation: bookNavigationState(
                [{ id: "note01", title: "Getting started", children: [{ id: "note02", title: "Welcome", children: [] }] }],
                selectedNoteId,
              ),
            });
          },
        });
      },
    }),
  );

describe("Book on v2", () => {
  test("only a rendered note becomes a print region", async () => {
    expect(await selectHtml(render(), "article#notebook-book-content[data-print-region]")).toHaveLength(1);
    expect(await selectHtml(render(false, false, "en", null), "[data-print-region]")).toHaveLength(0);
    // The incomplete-history warning prints with the note it qualifies.
    expect(await selectHtml(render(false, false, "en", undefined, true), "#notebook-book-history-warning[data-print-region]")).toHaveLength(
      1,
    );
    expect(await selectHtml(render(false, false, "en", null, true), "[data-print-region]")).toHaveLength(0);
  });
  test.each([
    ["en", "Switch notebook"],
    ["de", "Notizbuch wechseln"],
  ])("names the container and puts its overview only in switcher actions (%s)", async (locale, purpose) => {
    const html = render(false, false, locale);
    const trigger = await selectHtml(html, ".k2b-sidebar-switcher__trigger");
    expect(trigger).toHaveLength(1);
    expect(trigger[0]?.attributes["aria-label"]).toBe("Company handbook");
    expect((await selectHtml(html, ".k2b-sidebar-switcher .k2b-sr-only"))[0]?.text).toContain(purpose);
    const snapshot = (await selectHtml(html, "script[data-cloud-workspace-navigation]"))[0]?.text;
    expect(snapshot).toContain('"switchLabel":"' + purpose + '"');
    expect(snapshot).not.toContain('"id":"all"');
    expect(await selectHtml(html, '.k2b-app-workspace__sidebar-item[href="/app/notebooks"]')).toHaveLength(0);
    expect((await selectHtml(html, '.k2b-sidebar-switcher__actions a[href="/app/notebooks"]'))[0]?.text).toContain(
      locale === "en" ? "All notebooks" : "Alle Notizbücher",
    );
  });

  test("keeps the incomplete-history warning visible to readers", () => {
    const recovered = render(false, false, "en", "<p>Recovered content</p>", true);
    expect(recovered).toContain("Some note changes could not be recovered");
    expect(recovered).toContain('id="notebook-book-history-warning" role="status"');
    expect(render()).toMatch(/id="notebook-book-history-warning" hidden/);
  });
  test("renders a complete article and reading navigation without the editor or inspector", async () => {
    const html = render();
    expect(html).toContain("Our handbook.");
    // one v2 workspace whose Canvas holds the reading surface
    expect((await selectHtml(html, "[data-k2-workspace]")).length).toBe(1);
    expect((await selectHtml(html, '[data-k2-part="Canvas"] .notebook-book-main article.notebook-book-content')).length).toBe(1);
    expect(html).toContain("Getting started");
    expect(html).toContain("/app/notebooks/book01/notes/note02?mode=book");
    expect(html).toContain("/app/notebooks/book01/notes?tag=handbook&amp;mode=book");
    expect(html).not.toMatch(/CodeMirror|NoteEditor|NotebookDetailPanel|EditorToolbar|mode=write|mode=readonly/);
    expect(html).toContain("data-cloud-workspace-navigation");
  });
  test("the frame and the article are server markup; only the navigation, the head and the live parts are islands", async () => {
    const html = render(true);
    expect(await selectHtml(html, "solid-island #notebook-book-content")).toHaveLength(0);
    expect(await selectHtml(html, "solid-island [data-k2-workspace]")).toHaveLength(0);
    const islands = (await selectHtml(html, "solid-island")).map((island) => island.attributes["data-file"]);
    expect(islands.filter((file) => file?.startsWith("Book"))).toEqual([
      "BookSidebar.island.tsx",
      "BookHead.island.tsx",
      "BookController.island.tsx",
      "BookMermaid.island.tsx",
      "BookCharts.island.tsx",
    ]);
    // the notebook is named once, by the sidebar (on the phone by the shell's title row); the head names the note's
    // people from the server on, for writers and readers
    for (const page of [render(), html]) {
      const [head] = await selectHtml(page, '[data-slot="head"]');
      expect(head?.text).not.toContain("Company handbook");
      expect(head?.text).toContain("last changed by Lena Hartwig · ");
      expect(await selectHtml(page, '[data-slot="head"] [data-k2-part="Avatar"]')).toHaveLength(1);
      // the view menu stands in the server's frame, so nothing moves into the head when the browser takes over
      expect((await selectHtml(page, '[data-slot="head"] button[data-slot="menu-trigger"]')).map((button) => button.text.trim())).toContain(
        "View",
      );
    }
    // the pane keeps one name while the reader moves from note to note
    expect((await selectHtml(html, '[data-k2-part="Pane"]'))[0]?.attributes["aria-label"]).toBe("Company handbook");
  });
  test("the sidebar can be hidden, and a page renders it hidden as the person left it", async () => {
    expect(await selectHtml(render(), "[data-k2-workspace][data-collapsible]:not([data-collapsed])")).toHaveLength(1);
    expect(
      await selectHtml(render(false, false, "en", undefined, false, undefined, true), "[data-k2-workspace][data-collapsed]"),
    ).toHaveLength(1);
  });
  test("a page load shows the open page's sub-pages, so they stay reachable before or without JavaScript", () => {
    const html = render(false, false, "en", "<h1>Getting started</h1>", false, "note01");
    expect(html).toMatch(/role="treeitem"[^>]*aria-expanded="true"[^>]*data-k2b-nav-tree-id="note01"/);
    expect(html).toContain('<a href="/app/notebooks/book01/notes/note02?mode=book"');
  });
  test("authors get the views Edit, Read and Book in the head, Edit only on unlocked notes", async () => {
    const views = async (html: string) =>
      (await selectHtml(html, '[data-k2-part="Tabs"] a')).map((tab) => [
        tab.text.trim(),
        tab.attributes.href,
        tab.attributes["aria-current"],
      ]);
    expect(await views(render(true))).toEqual([
      ["Edit", "/app/notebooks/book01/notes/note02?mode=write", undefined],
      ["Read", "/app/notebooks/book01/notes/note02?mode=readonly", undefined],
      ["Book", "/app/notebooks/book01/notes/note02?mode=book", "page"],
    ]);
    expect((await views(render(true, true))).map(([label]) => label)).toEqual(["Read", "Book"]);
    // readers stay in Book: no views; the note's title is the article's first heading
    expect(await views(render())).toEqual([]);
    expect(render()).not.toMatch(/mode=write|mode=readonly/);
  });
  test("authors can leave an empty Book without exposing an edit action to readers", async () => {
    // the head's Read leads into the workspace; the navigation offers no second way
    const empty = render(true, false, "en", null);
    expect(empty).toContain("/app/notebooks/book01?mode=readonly");
    expect(empty).not.toContain("Open workspace");
    expect(empty).not.toContain("mode=write");
    expect(render(false, false, "en", null)).not.toContain("mode=readonly");
  });
  test("localizes controls and empty states without leaking editor data", () => {
    expect(bookMessages.check()).toEqual([]);
    expect(render(true, false, "de-CH")).toContain("Bearbeiten");
    expect(render(false, false, "de", null)).toContain("Wähle eine Seite");
    expect(render(false, false, "de")).not.toContain("yjsSnapshot");
  });
});
