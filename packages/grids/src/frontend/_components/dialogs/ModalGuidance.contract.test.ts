import { describe, expect, test } from "bun:test";

const source = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

describe("Grids settings dialog guidance", () => {
  test("explains table integrity features in user language", async () => {
    const audit = await source("./AuditPolicyDialog.tsx");
    const history = await source("./HistoryProtectionDialog.tsx");
    const messages = await source("./messages.ts");

    expect(audit).toContain("title={t().askReason}");
    expect(messages).toContain('askReason: "Ask for a reason before important changes"');
    expect(audit).not.toContain("operation metadata");
    expect(audit).not.toContain("rejected by the backend");
    expect(history).toContain("title={t().historyIntro}");
    expect(messages).toContain('historyOn: "Durable history is on"');
    expect(history).toContain("title={t().finalizationOn}");
    expect(history.match(/class="w-full"/g)).toHaveLength(2);
    expect(history).not.toContain("append-only");
  });

  test("explains field choices and numbering before configuration", async () => {
    const tableSettings = await source("./TableAdminDialogs.tsx");
    const fieldEditor = await source("../fields/FieldEditorDialog.tsx");
    const fieldConfig = await source("../fields/field-config-editor.tsx");
    const dialogMessages = await source("./messages.ts");
    const fieldMessages = await source("../fields/messages.ts");

    expect(tableSettings).toContain("title={t.chooseFieldStorage}");
    expect(dialogMessages).toContain('chooseFieldStorage: "Choose what this field stores"');
    expect(fieldEditor).toContain("subtitle={typeDescription() || t().typeSettingsDescription}");
    expect(fieldEditor).toContain("title={t().numberSeries}");
    expect(fieldConfig).toContain("title={t().uniqueNumber}");
    expect(fieldMessages).toContain('uniqueNumber: "Each record gets its own number"');
    expect(fieldConfig).not.toContain("increase atomically");
  });

  test("explains view-only and combined-table changes", async () => {
    const viewSettings = await source("./ViewSettingsDialogs.tsx");
    const computedColumn = await source("../records-view/ComputedColumnDialog.tsx");
    const combinedTable = await source("./FederatedTableDialog.tsx");
    const recordAudit = await source("../records/RecordAuditDialog.tsx");
    const recordDocuments = await source("../records/RecordDocumentsSection.tsx");
    const documentGenerate = await source("../documents/DocumentGenerateDialog.tsx");
    const messages = await source("./messages.ts");

    expect(viewSettings).toContain("title={t().controlView}");
    expect(messages).toContain('controlView: "Control what this view shows"');
    expect(messages).toContain("records remain unchanged");
    expect(computedColumn).toContain("title={t().computedTitle}");
    expect(combinedTable).toContain("subtitle={t().fieldMappingsDetail}");
    expect(messages).toContain("choose the source field whose value should appear");
    expect(recordAudit).toContain("title={t().whyRequired}");
    expect(documentGenerate).toContain("title={t().immutableGeneratedDocument}");
    expect(recordDocuments).not.toContain("recursive record snapshot");
  });
});
