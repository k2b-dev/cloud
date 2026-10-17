import { describe, expect, test } from "bun:test";
import { LocaleProvider, type NavigationItem } from "@k2b/ui";
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
    fullWidth: false,
    permission: "read",
    attachmentCount: 0,
    favoriteNoteIds: [],
    tags: [{ tag: "garden", count: 2 }],
    workspaceCursor: null,
    dateConfig: { locale: "en", timeZone: "UTC" },
    sidebarFilter: {},
  });

  const renderSidebar = (value = ctx(), current?: "attachments" | "graph", locale = "en", graphBack?: string) =>
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(NotebookSidebar, { ctx: value, current, graphBack });
        },
      }),
    );

  test.each([
    ["en", "Links", "Attachments", "Settings"],
    ["de", "Verknüpfungen", "Anhänge", "Einstellungen"],
  ])("the footer has three labelled sidebar rows (%s)", async (locale, graph, attachments, settings) => {
    for (const presentationMode of [undefined, "write", "readonly"] as const) {
      const html = renderSidebar({ ...ctx(), presentationMode }, undefined, locale);
      const rows = await selectHtml(html, ".notebook-sidebar-foot .k2b-app-workspace__sidebar-item");
      expect(rows.map((row) => row.text.trim())).toEqual([graph, attachments, settings]);
      const links = await selectHtml(html, ".notebook-sidebar-foot a");
      expect(links).toHaveLength(2);
      expect(links[0]?.attributes.href).toBe(`/app/notebooks/Book01?mode=graph${presentationMode ? `&amp;from=${presentationMode}` : ""}`);
      expect(links[1]?.attributes.href).toBe(`/app/notebooks/Book01/attachments${presentationMode ? `?mode=${presentationMode}` : ""}`);
      const buttons = await selectHtml(html, ".notebook-sidebar-foot button");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]?.text.trim()).toBe(settings);
      expect(await selectHtml(html, ".notebook-sidebar-foot .k2b-app-workspace__sidebar-item-icon i")).toHaveLength(3);
    }
  });

  test.each([undefined, "attachments", "graph"] as const)(
    "only the current page marks its desktop and mobile destination current (%s)",
    async (current) => {
      const html = renderSidebar(ctx(), current);
      const active = await selectHtml(html, '.notebook-sidebar-foot [aria-current="page"]');
      expect(active.map((row) => row.text.trim())).toEqual(
        current === "graph" ? ["Links"] : current === "attachments" ? ["Attachments"] : [],
      );
      const snapshot = (await selectHtml(html, "script[data-cloud-workspace-navigation]"))[0]!.text;
      const navigation: { items: NavigationItem[] } = JSON.parse(snapshot);
      expect(navigation.items.find((item) => item.id === "attachments")?.active).toBe(current === "attachments");
      expect(navigation.items.find((item) => item.id === "graph")?.active).toBe(current === "graph");
      expect(navigation.items.find((item) => item.id === "settings")?.active).toBeUndefined();
    },
  );

  test.each([0, 7])("the attachments row shows positive counts only, as metadata (%s)", async (attachmentCount) => {
    const html = renderSidebar({ ...ctx(), attachmentCount });
    const meta = await selectHtml(html, ".notebook-sidebar-foot .k2b-app-workspace__sidebar-item-meta");
    expect(meta.map((item) => item.text.trim())).toEqual(attachmentCount > 0 ? [String(attachmentCount)] : []);
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

  test.each([null, "note01"])("Links carries the return page only without a selected note (%s)", async (selectedNoteId) => {
    const graphBack = "/app/notebooks/Book01/attachments?search=x&page=2";
    const html = renderSidebar({ ...ctx(), selectedNoteId }, undefined, "en", graphBack);
    const links = await selectHtml(html, ".notebook-sidebar-foot a");
    const href = `/app/notebooks/Book01?mode=graph${selectedNoteId ? "&note=note01" : `&back=${encodeURIComponent(graphBack)}`}`;
    expect(links[0]?.attributes.href).toBe(href.replaceAll("&", "&amp;"));
    const navigation: { items: NavigationItem[] } = JSON.parse(
      (await selectHtml(html, "script[data-cloud-workspace-navigation]"))[0]!.text,
    );
    expect(navigation.items.find((item) => item.id === "graph")?.href).toBe(href);
  });
});
