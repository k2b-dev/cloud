import { describe, expect, test } from "bun:test";

describe("Record document detail surfaces", () => {
  test("uses DetailPanel groups and actions for snapshots and generated documents", async () => {
    const source = await Bun.file(new URL("./RecordDocumentsSection.tsx", import.meta.url)).text();

    expect(source).toContain("<DetailPanel.Group label={t().recordSnapshots}>");
    expect(source).toContain("<DetailPanel.Group label={t().generatedDocuments}>");
    expect(source).toContain("<DetailPanel.Group label={t().snapshotMetadata}>");
    expect(source.match(/<DetailPanel\.Action/g)).toHaveLength(2);
    expect(source).not.toContain('class="group flex min-w-0 items-center');
  });
});
