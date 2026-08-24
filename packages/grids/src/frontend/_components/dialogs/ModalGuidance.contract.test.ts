import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Grids settings dialog guidance", () => {
  test("explains table integrity features in user language", async () => {
    const audit = await source("./AuditPolicyDialog.tsx");
    const history = await source("./HistoryProtectionDialog.tsx");

    expect(audit).toContain('title="Ask for a reason before important changes"');
    expect(audit).not.toContain("operation metadata");
    expect(audit).not.toContain("rejected by the backend");
    expect(history).toContain('title="Keep a history, then lock finished records"');
    expect(history).toContain('"Durable history is on"');
    expect(history).toContain('title="Finalization is on"');
    expect(history.match(/class="w-full"/g)).toHaveLength(2);
    expect(history).not.toContain("append-only");
  });

  test("explains field choices and numbering before configuration", async () => {
    const tableSettings = await source("./TableAdminDialogs.tsx");
    const fieldEditor = await source("../fields/FieldEditorDialog.tsx");
    const fieldConfig = await source("../fields/field-config-editor.tsx");

    expect(tableSettings).toContain('title="Choose what this field stores"');
    expect(fieldEditor).toContain("title={`About ${typeLabel} fields`}");
    expect(fieldEditor).toContain('title="Number series"');
    expect(fieldConfig).toContain('title="Each record gets its own number"');
    expect(fieldConfig).not.toContain("increase atomically");
  });

  test("explains view-only and combined-table changes", async () => {
    const viewSettings = await source("./ViewSettingsDialogs.tsx");
    const computedColumn = await source("../records-view/ComputedColumnDialog.tsx");
    const combinedTable = await source("./FederatedTableDialog.tsx");
    const recordAudit = await source("../records/RecordAuditDialog.tsx");
    const recordDocuments = await source("../records/RecordDocumentsSection.tsx");
    const documentGenerate = await source("../documents/DocumentGenerateDialog.tsx");

    expect(viewSettings).toContain('title="Control what this view shows"');
    expect(viewSettings).toContain("does not change the records themselves");
    expect(computedColumn).toContain('title="Show a value calculated for this view"');
    expect(combinedTable).toContain("choose the source field whose value should appear");
    expect(recordAudit).toContain('title="Why this is required"');
    expect(documentGenerate).toContain('title="The generated Document stays unchanged"');
    expect(recordDocuments).not.toContain("recursive record snapshot");
  });
});
