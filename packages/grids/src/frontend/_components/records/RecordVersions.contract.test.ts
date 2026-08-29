import { describe, expect, test } from "bun:test";

describe("record durable history UI contract", () => {
  test("loads bounded versions lazily and keeps historical files on the permission-aware record route", async () => {
    const source = await Bun.file(new URL("./RecordVersions.island.tsx", import.meta.url)).text();
    expect(source).toContain("query.createInfinite");
    expect(source).toContain("RECORD_VERSION_PAGE_SIZE = 5");
    expect(source).toContain("title={t().durableHistory}");
    expect(source).toContain("label={t().on}");
    expect(source).toContain("<DetailPanel.Group");
    expect(source).toContain("<DetailPanel.Section");
    expect(source).toContain("<DetailPanel.Action");
    expect(source).toContain("/versions/${encodeURIComponent(props.revision.id)}/files/");
    expect(source).not.toContain("custom-app");
  });

  test("uses the shared irreversible confirmation in table settings", async () => {
    const source = await Bun.file(new URL("../dialogs/HistoryProtectionDialog.tsx", import.meta.url)).text();
    expect(source).toContain("title={t().durableHistory}");
    expect(source).toContain("prompts.confirm(");
    expect(source).toContain("confirmText: t().enableHistory");
    expect(source).toContain("t().historyEnableConfirm");
    expect(source).toContain("statusQuery.error()");
    expect(source).toContain("t().retry");
    expect(source).not.toContain("disableHistory");
  });
});
