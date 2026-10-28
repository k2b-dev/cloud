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

  test("lists generated documents as files and snapshots as a collapsed section with a summary", async () => {
    const source = await Bun.file(new URL("./RecordDocumentsSection.tsx", import.meta.url)).text();

    expect(source).toContain("<FileGrid");
    expect(source).toContain("limit={5}");
    expect(source).toContain('actionVisibility="progressive"');
    expect(source).toContain("title={t().snapshots}");
    expect(source).toContain("collapsible");
    expect(source).toContain("summary={");
    expect(source).toContain("title={t().createSnapshot}");
    expect(source).not.toContain('icon="ti ti-camera"\n');
    expect(source).not.toContain('class="group flex min-w-0 items-center');
  });
});
