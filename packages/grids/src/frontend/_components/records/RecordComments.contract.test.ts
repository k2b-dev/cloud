import { describe, expect, test } from "bun:test";

describe("App record comments", () => {
  test("uses a DetailPanel section without creating a nested scroll owner", async () => {
    const source = await Bun.file(new URL("./RecordComments.island.tsx", import.meta.url)).text();

    expect(source).toContain("<DetailPanel.Group label={t().recordComments}>");
    expect(source).toContain("<DetailPanel.Section");
    expect(source).toContain('icon="ti ti-messages"');
    expect(source).toContain("<Discussion.List");
    expect(source).toContain("<Discussion.Composer");
    expect(source).not.toContain("overflow-y-auto");
    expect(source).not.toContain('class="detail-section');
    expect(source).not.toContain("detail-section-label");
    expect(source).not.toContain("PanelHeader");
    expect(source).toContain('recordCommentsCursorUrl(props.endpoint, cursor, props.cursorParameter ?? "cursor")');
    expect(source.match(/recordCommentUrl\(props.endpoint, comment.id\)/g)).toHaveLength(2);
    const appPage = await Bun.file(new URL("../../custom-app/page.tsx", import.meta.url)).text();
    expect(appPage).toContain('cursorParameter="_cursor"');
  });
});
