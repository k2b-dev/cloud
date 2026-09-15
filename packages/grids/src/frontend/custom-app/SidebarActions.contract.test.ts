import { describe, expect, test } from "bun:test";

describe("Grids App sidebar Forms", () => {
  test("uses shared workspace, dialog, and form primitives without a workflow surface", async () => {
    const source = await Bun.file(new URL("./SidebarActions.island.tsx", import.meta.url)).text();
    const dialog = await Bun.file(new URL("./sidebar-form.tsx", import.meta.url)).text();
    expect(source).toContain("AppWorkspace.SidebarItem");
    expect(source).toContain("openCustomAppSidebarForm(action)");
    expect(dialog).toContain("dialogCore.open");
    expect(dialog).toContain("<PanelDialog>");
    expect(dialog).toContain("panelDialogOptions");
    expect(dialog).not.toContain("panelDialogWideOptions");
    expect(dialog).toContain("<FormSubmit");
    expect(source).not.toContain("invokeCustomAppWorkflow");
    expect(source).not.toContain('kind: "workflow"');
  });
});
