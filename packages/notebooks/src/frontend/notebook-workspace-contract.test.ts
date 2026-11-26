import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Notebooks workspace contract", () => {
  test("a note opens in the v2 workspace; Cloud's layout state stays the shell's", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/page.tsx")).text();

    expect(source).toContain("<NoteWorkspace");
    expect(source).toContain('ui="v2"');
    expect(source).not.toContain("initialWorkspaceLayout");
    expect(source).not.toContain("layoutState={() =>");
  });

  test("has one sidebar and no second note-list pane", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/page.tsx")).text();

    expect(source).not.toContain("AppWorkspace.MainPane");
    expect(source).not.toContain("Navigator");
  });

  test("keeps notebook settings modal-only and opens without an access preflight", async () => {
    const pageSource = await Bun.file(resolve(import.meta.dir, "[id]/page.tsx")).text();
    const pageDataSource = await Bun.file(resolve(import.meta.dir, "[id]/page-data.ts")).text();
    const sidebarSource = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/notebook-sidebar-state.ts")).text();
    const openSettings = sidebarSource.slice(sidebarSource.indexOf("const openSettings ="), sidebarSource.indexOf("const chooseNewNote ="));
    expect(openSettings.length).toBeGreaterThan(0);

    expect(pageSource).not.toContain("NotebookSettingsPanel.island");
    expect(pageDataSource).not.toContain("isSettingsMode");
    expect(openSettings).not.toContain("apiClient");
    expect(openSettings).toContain("openNotebookSettingsDialog");
  });

  test("the details show who is here as their own section", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/detail/NoteDetails.tsx")).text();

    expect(source).toContain("title={t().hereNow}");
  });

  test("uses shared tree rows and action visibility for note navigation", async () => {
    const tree = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NoteTree.tsx")).text();
    const rows = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/note-rows.tsx")).text();

    expect(tree).toContain("<AppWorkspace.NavTree");
    expect(rows).toContain('<AppWorkspace.SidebarItemActions visibility="hover">');
    expect(tree).not.toContain("group-hover/node");
  });
});
