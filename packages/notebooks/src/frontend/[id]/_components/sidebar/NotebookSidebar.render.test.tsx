import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../../../../tests/fixtures/select-html";
import type { NotebookContext } from "./types";
import "../detail/ssr-test-plugin";

const { default: NotebookSidebar } = await import("./NotebookSidebar.island");

describe("Notebook workspace container head", () => {
  const ctx = (): NotebookContext => ({
    notebook: {
      id: "Book01",
      name: "Journal",
      description: null,
      icon: null,
      homepageNoteId: null,
      defaultPresentationMode: "write",
      defaultNoteTitleTemplate: "",
      noteDeletePermission: "write",
      createdBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    tree: [],
    selectedNoteId: null,
    userId: "user01",
    settings: { lastNoteId: null, richMode: "rich", treeSort: "title" },
    navigationHidden: false,
    permission: "read",
    attachmentCount: 0,
    favoriteNoteIds: [],
    tags: [{ tag: "garden", count: 2 }],
    workspaceCursor: null,
    dateConfig: { locale: "en", timeZone: "UTC" },
    sidebarFilter: {},
  });

  test.each([
    ["en", "Switch notebook"],
    ["de", "Notizbuch wechseln"],
  ])("names the container and puts its overview only in switcher actions (%s)", async (locale, purpose) => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(NotebookSidebar, { ctx: ctx() });
        },
      }),
    );
    const trigger = await selectHtml(html, ".k2b-sidebar-switcher__trigger");
    expect(trigger).toHaveLength(1);
    expect(trigger[0]?.attributes["aria-label"]).toBe("Journal");
    expect((await selectHtml(html, ".k2b-sidebar-switcher .k2b-sr-only"))[0]?.text).toContain(purpose);
    const snapshot = (await selectHtml(html, "script[data-cloud-workspace-navigation]"))[0]?.text;
    expect(snapshot).toContain('"switchLabel":"' + purpose + '"');
    expect(snapshot).not.toContain('"id":"all"');
    expect(await selectHtml(html, '.k2b-app-workspace__sidebar-item[href="/app/notebooks"]')).toHaveLength(0);
    expect((await selectHtml(html, '.k2b-sidebar-switcher__actions a[href="/app/notebooks"]'))[0]?.text).toContain(
      locale === "en" ? "All notebooks" : "Alle Notizbücher",
    );
  });
});
