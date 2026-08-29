import { describe, expect, test } from "bun:test";

describe("Evidence exports settings contract", () => {
  test("keeps the admin flow bounded, explicit, and honest about missing history", async () => {
    const [section, coverageDialog, panel, messages] = await Promise.all([
      Bun.file(new URL("./EvidenceExportsSection.tsx", import.meta.url)).text(),
      Bun.file(new URL("./EvidenceCoverageDialog.tsx", import.meta.url)).text(),
      Bun.file(new URL("./BaseSettingsPanel.tsx", import.meta.url)).text(),
      Bun.file(new URL("./messages.ts", import.meta.url)).text(),
    ]);

    expect(panel).toContain('id="evidence"');
    expect(messages).toContain("A verifiable package, not a compliance certificate");
    expect(messages).toContain("Available evidence");
    expect(messages).toContain("This check changes nothing and is not a compliance assessment");
    expect(messages).toContain("Review Table coverage");
    expect(section).toContain('class="mb-8"');
    expect(messages).toContain("Evidence coverage by Table");
    expect(messages).toContain("Earlier states unavailable");
    expect(messages).toContain("Building baseline");
    expect(messages).toContain("Not enabled");
    expect(messages).toContain("Evidence coverage is unavailable");
    expect(messages).toContain("No stored Tables in this Base");
    expect(messages).toContain("Open Table");
    expect(coverageDialog).toContain("DataTable");
    expect(messages).toContain("Everything is selected by default");
    expect(messages).toContain("Known scope fits the export budgets");
    expect(messages).toContain("Scope could not be checked");
    expect(messages).toContain("No evidence exports yet");
    expect(section).not.toContain("Recent packages");
    expect(messages).toContain("Limits dated evidence; current Records are always included.");
    expect(messages).toContain("Package details");
    expect(messages).toContain("Copy command");
    expect(section).toContain("cld grids evidence verify");
    expect(section).toContain("--manifest-sha256");
    expect(section).toContain("<DescriptionList");
    expect(section).toContain("<StatGrid");
    expect(section).not.toContain("<details");
    expect(messages).toContain("Packages expire after seven days");
    expect(section).toContain("useGridsSettingsMessages(locale)");
    expect(section).toContain('item.status === "failed" || item.status === "canceled"');
    expect(section).toContain('item.status === "queued" || item.status === "running"');
  });
});
