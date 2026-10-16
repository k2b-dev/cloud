import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Notebooks workspace contract", () => {
  test("inherits the cookie-backed workspace layout rendered by Cloud", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/page.tsx")).text();

    expect(source).toMatch(/<AppWorkspace\b[^>]*class="notebooks-workspace flex-1 min-h-0"/);
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
    const sidebarSource = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NotebookSidebar.island.tsx")).text();
    const openSettings = sidebarSource.slice(
      sidebarSource.indexOf("const openSettings ="),
      sidebarSource.indexOf("const navigationHidden ="),
    );

    expect(pageSource).not.toContain("NotebookSettingsPanel.island");
    expect(pageDataSource).not.toContain("isSettingsMode");
    expect(openSettings).not.toContain("apiClient");
    expect(openSettings).toContain("openNotebookSettingsDialog");
  });

  test("gives presence identities a visible gap", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/detail/NotebookDetailPanel.island.tsx")).text();

    // The gap separates avatar and name; the row itself starts at the section's content edge like the rows around it.
    expect(source).toContain('<li class="flex items-center gap-3 py-1.5 text-sm text-primary">');
  });

  test("uses shared tree rows and action visibility for note navigation", async () => {
    const tree = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NoteTree.tsx")).text();
    const rows = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/note-rows.tsx")).text();

    expect(tree).toContain("<AppWorkspace.NavTree");
    expect(rows).toContain('<AppWorkspace.SidebarItemActions visibility="hover">');
    expect(tree).not.toContain("group-hover/node");
  });
});
