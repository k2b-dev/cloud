import { describe, expect, test } from "bun:test";

describe("Grids App sidebar Forms", () => {
  test("uses shared workspace, dialog, and form primitives without a workflow surface", async () => {
    const source = await Bun.file(new URL("./SidebarActions.island.tsx", import.meta.url)).text();
    const dialog = await Bun.file(new URL("./sidebar-form.tsx", import.meta.url)).text();
    expect(source).toContain("AppWorkspace.SidebarItem");
    expect(source).toContain("openCustomAppSidebarForm(action)");
    expect(source).toContain('await import("./sidebar-form")');
    expect(source).not.toContain("import { openCustomAppSidebarForm }");
    expect(dialog).toContain("dialogCore.open");
    expect(dialog).toContain("<PanelDialog>");
    expect(dialog).toContain("panelDialogOptions");
    expect(dialog).not.toContain("panelDialogWideOptions");
    expect(dialog).toContain("<FormSubmit");
    expect(source).not.toContain("invokeCustomAppWorkflow");
    expect(source).not.toContain('kind: "workflow"');
  });

  test("navigation receives only page presentation and defers the form renderer", async () => {
    const navigation = await Bun.file(new URL("./CustomAppNavigation.island.tsx", import.meta.url)).text();
    const page = await Bun.file(new URL("./page.tsx", import.meta.url)).text();
    expect(navigation).not.toContain("CustomAppDefinition");
    expect(navigation).not.toContain("props.definition");
    expect(navigation).toContain('await import("./sidebar-form")');
    expect(navigation).not.toContain("import { openCustomAppSidebarForm");
    expect(page).not.toContain("<CustomAppNavigation definition=");
    expect(page).toMatch(/pages=\{props\.definition\.pages\s*\.filter/);
  });
});
