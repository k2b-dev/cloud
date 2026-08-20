import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { SettingsModal } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "grids-base-settings-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: BaseSettingsPanel }, { DocumentProfileForm }, { buildPreservationHoldInput, CreatePreservationHoldDialog }] =
  await Promise.all([import("./BaseSettingsPanel.tsx"), import("./BaseSettingsSections.tsx"), import("./PreservationHoldsSection.tsx")]);

const base = {
  id: "BASE01",
  name: "Operations",
  description: "Operational records",
  documentProfile: {},
  createdBy: null,
  deletedAt: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

describe("Grids Base settings composition", () => {
  test("groups the category rail and gives General one panel footer", () => {
    const html = renderToString(() =>
      createComponent(BaseSettingsPanel, {
        base,
        accessEntries: [],
        onClose: () => undefined,
      }),
    );

    for (const group of ["Base", "Sharing", "Recovery", "Lifecycle"]) expect(html).toContain(group);
    for (const tab of [
      "General",
      "Tables",
      "Documents",
      "Access",
      "Trash",
      "Retention",
      "Preservation holds",
      "Evidence exports",
      "Controlled destruction",
      "Danger zone",
    ])
      expect(html).toContain(tab);
    expect(html).toContain("Identity shown across Grids.");
    expect(html).toContain("Describe this Base wherever it appears in Grids.");
    expect(html.match(/<footer class="k2b-settings__footer">/g)).toHaveLength(1);
    expect(html).toContain('aria-describedby="k2b-settings-field-');
  });

  test("opens the server-filtered Tables overview in its own workspace dialog", () => {
    const panel = readFileSync(join(import.meta.dir, "BaseSettingsPanel.tsx"), "utf8");
    const source = readFileSync(join(import.meta.dir, "TablesOverviewSection.tsx"), "utf8");
    expect(panel).toContain('id="tables"');
    expect(source).toContain("query.create");
    expect(source).toContain("admin-overview");
    expect(source).toContain("dialogCore.open");
    expect(source).toContain("panelDialogWorkspaceOptions");
    expect(source).toContain("<PanelDialog>");
    expect(source).toContain("Review Tables");
    expect(source).toContain("Durable History");
    expect(source).toContain("Finalization");
    expect(source).toContain("indexedFieldCount");
    expect(source).toContain("<DataTable.Controls>");
    expect(source).toContain('<div class="w-full">');
    expect(source).not.toContain('class="min-w-64 flex-1"');
    expect(source).not.toContain("onRowClick");
    expect(source).not.toContain("recordCount");
  });

  test("keeps scoped holds in their own lifecycle category with explicit consequences", () => {
    const source = readFileSync(join(import.meta.dir, "PreservationHoldsSection.tsx"), "utf8");
    const panel = readFileSync(join(import.meta.dir, "BaseSettingsPanel.tsx"), "utf8");
    expect(source).toContain("Preservation holds");
    expect(source).toContain("query.create");
    expect(source).toContain("Every active hold must be released separately.");
    expect(source).toContain("A Table hold also prevents deleting its parent Base");
    expect(source).toContain('class="mt-5"');
    expect(source).toContain('class="ti ti-lock"');
    expect(source).toContain('"ti ti-database" : "ti ti-table"');
    expect(source).toContain("fetchData");
    expect(source).toContain('limit: "25"');
    expect(source).toContain("Could not search Tables");
    expect(source).toContain("Could not load preservation holds");
    expect(source).toContain("setTableId(null)");
    expect(source).toContain("holds.refresh()");
    expect(source).toContain("active holds could not be refreshed");
    expect(panel).toContain('id="holds"');
    expect(panel).toContain('id="destruction"');
    expect(readFileSync(join(import.meta.dir, "RetentionPolicySection.tsx"), "utf8")).not.toContain("ControlledDestructionSection");
  });

  test("builds only valid Base and Table hold intents", () => {
    expect(buildPreservationHoldInput("base", null, " Annual review ")).toEqual({
      reason: "Annual review",
      scope: { type: "base" },
    });
    expect(buildPreservationHoldInput("table", "TABLE1", " Invoice dispute ")).toEqual({
      reason: "Invoice dispute",
      scope: { type: "table", tableId: "TABLE1" },
    });
    expect(buildPreservationHoldInput("table", null, "Invoice dispute")).toBeNull();
    expect(buildPreservationHoldInput("base", null, " ")).toBeNull();

    const html = renderToString(() =>
      createComponent(CreatePreservationHoldDialog, {
        baseId: base.id,
        close: () => undefined,
      }),
    );
    expect(html).toContain("Entire Base");
    expect(html).toContain("One Table");
    expect(html).toContain("parent Base cannot be destroyed");
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });

  test("groups the long document form behind one save footer", () => {
    const html = renderToString(() =>
      createComponent(SettingsModal, {
        title: "Base settings",
        defaultTab: "documents",
        children: createComponent(SettingsModal.Tab, {
          id: "documents",
          title: "Documents",
          children: createComponent(DocumentProfileForm, {
            base,
            onDirtyChange: () => undefined,
            onSavingChange: () => undefined,
          }),
        }),
      }),
    );

    expect(html).toContain("Business identity");
    expect(html).toContain("Contact");
    expect(html).toContain("Billing and footer");
    expect(html.match(/<footer class="k2b-settings__footer">/g)).toHaveLength(1);
    expect(html).not.toContain("Save document profile");
  });

  test("keeps every dialog exit behind the dirty and save guards", () => {
    const panel = readFileSync(join(import.meta.dir, "BaseSettingsPanel.tsx"), "utf8");
    const sections = readFileSync(join(import.meta.dir, "BaseSettingsSections.tsx"), "utf8");
    const opener = readFileSync(join(import.meta.dir, "../sidebar/BaseSettingsButton.island.tsx"), "utf8");

    expect(opener).toContain('cancelBehavior: "ignore"');
    expect(panel).toContain("navigationPending() || savePending()");
    expect(panel).toContain("confirmDiscardIfDirty(hasUnsavedChanges)");
    expect(panel).toContain("confirmDiscardIfDirty(hasUnsavedChanges)) || savePending()");
    expect(panel).toContain("restoreActiveTabFocus");
    expect(sections).toContain("mutation.abort()");
    expect(sections).toContain("deleteMut.abort()");
    expect(sections).toContain("{ abortSignal }");
  });
});
