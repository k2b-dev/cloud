import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("Notebooks navigator hydration contract", () => {
  test("controls tree expansion across SSR and hydration", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NotebookNavigator.tsx")).text();

    expect(source).toContain("expandedIds={expandedTreeIds()}");
    expect(source).toContain("onExpandedIdsChange={setExpandedTreeIds}");
    expect(source).not.toContain("defaultExpandedIds=");
  });

  test("inherits the cookie-backed workspace layout rendered by Cloud", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/page.tsx")).text();

    expect(source).toContain('<AppWorkspace class="flex-1 min-h-0">');
    expect(source).not.toContain("initialWorkspaceLayout");
    expect(source).not.toContain("layoutState={() =>");
  });

  test("keeps notebook settings modal-only and opens without an access preflight", async () => {
    const pageSource = await Bun.file(resolve(import.meta.dir, "[id]/page.tsx")).text();
    const pageDataSource = await Bun.file(resolve(import.meta.dir, "[id]/page-data.ts")).text();
    const buttonSource = await Bun.file(resolve(import.meta.dir, "[id]/_components/settings/NotebookSettingsButton.tsx")).text();

    expect(pageSource).not.toContain("NotebookSettingsPanel.island");
    expect(pageDataSource).not.toContain("isSettingsMode");
    expect(buttonSource).not.toContain("apiClient");
    expect(buttonSource).toContain("openNotebookSettingsDialog");
  });

  test("gives presence identities a visible gap", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/detail/NotebookDetailPanel.island.tsx")).text();

    expect(source).toContain('<li class="flex items-center gap-3 px-2 py-1.5 text-sm text-primary">');
  });

  test("renders primary notebook destinations as an icon-only grid", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NotebookNavigator.tsx")).text();

    expect(source).toContain("<AppWorkspace.SidebarIconGrid columns={2}>");
    expect(source).toContain("label={t().homepage}");
    expect(source).toContain('variant="workspace-icon"');
    expect(source).not.toContain('meta={root.id === "favorites"');
  });

  test("keeps navigator controls on one line while allowing both selects to shrink", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NotebookNavigator.tsx")).text();

    expect(source).toContain('<div class="flex min-w-0 shrink-0 items-center gap-2 pb-2">');
    expect(source).toContain('<SelectChip class="min-w-0" value={treeMode()}');
    expect(source).toContain('<SelectChip\n          class="min-w-0"\n          value={sortMode()}');
    expect(source).toContain('class="ml-auto shrink-0 text-green-600 dark:text-green-400"');
  });

  test("uses shared tree rows and action visibility for note navigation", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NoteTree.tsx")).text();

    expect(source).toContain("<AppWorkspace.NavTree");
    expect(source).toContain("<AppWorkspace.SidebarItemActions");
    expect(source).toContain('visibility="hover"');
    expect(source).not.toContain("group-hover/node");
  });

  test("places the persisted tree sort in the section header with a mobile equivalent", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "[id]/_components/sidebar/NotebookSidebar.island.tsx")).text();

    expect(source).toContain("actions={");
    expect(source).toContain("iconOnly");
    expect(source).toContain('icon="ti ti-arrows-sort"');
    expect(source.match(/aria-label=\{t\(\)\.sortNotes\}/g)).toHaveLength(2);
    expect(source).toContain("writeSettings(notebook().id, { treeSort: value })");
  });
});
