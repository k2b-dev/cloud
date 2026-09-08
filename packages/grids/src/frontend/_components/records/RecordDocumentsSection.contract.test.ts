import { describe, expect, test } from "bun:test";

describe("Record document detail surfaces", () => {
  test("keeps document write access independent of live records and enabled templates", async () => {
    const source = await Bun.file(new URL("./RecordDocumentsSection.tsx", import.meta.url)).text();
    const panel = await Bun.file(new URL("./RecordDetailPanel.tsx", import.meta.url)).text();
    expect(panel).toContain("canWrite={props.canWrite}");
    expect(source).toContain("canWrite: props.canWrite,");
    expect(source).toContain("const template = availableTemplates().find");
    expect(source).toContain("props.live && props.canWrite && template");
    expect(source).not.toContain("canWrite: props.live && availableTemplates().length > 0");
  });

  test("uses DetailPanel groups and actions for snapshots and generated documents", async () => {
    const source = await Bun.file(new URL("./RecordDocumentsSection.tsx", import.meta.url)).text();

    expect(source).toContain("<DetailPanel.Group label={t().recordSnapshots}>");
    expect(source).toContain("<DetailPanel.Group label={t().generatedDocuments}>");
    expect(source).toContain("<DetailPanel.Group label={t().snapshotMetadata}>");
    expect(source.match(/<DetailPanel\.Action/g)).toHaveLength(2);
    expect(source).not.toContain('class="group flex min-w-0 items-center');
  });
});
