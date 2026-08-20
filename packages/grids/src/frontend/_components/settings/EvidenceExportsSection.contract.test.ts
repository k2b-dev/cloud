import { describe, expect, test } from "bun:test";

describe("Evidence exports settings contract", () => {
  test("keeps the admin flow bounded, explicit, and honest about missing history", async () => {
    const [section, coverageDialog, panel] = await Promise.all([
      Bun.file(new URL("./EvidenceExportsSection.tsx", import.meta.url)).text(),
      Bun.file(new URL("./EvidenceCoverageDialog.tsx", import.meta.url)).text(),
      Bun.file(new URL("./BaseSettingsPanel.tsx", import.meta.url)).text(),
    ]);

    expect(panel).toContain('id="evidence"');
    expect(section).toContain("A verifiable package, not a compliance certificate");
    expect(section).toContain("Available evidence");
    expect(section).toContain("This check changes nothing and is not a compliance assessment");
    expect(section).toContain("Review Table coverage");
    expect(coverageDialog).toContain("Evidence coverage by Table");
    expect(coverageDialog).toContain("Earlier states unavailable");
    expect(coverageDialog).toContain("Building baseline");
    expect(coverageDialog).toContain("Not enabled");
    expect(section).toContain("Evidence coverage is unavailable");
    expect(coverageDialog).toContain("No stored Tables in this Base");
    expect(coverageDialog).toContain("Open Table");
    expect(coverageDialog).toContain("DataTable");
    expect(section).toContain("Everything is selected by default");
    expect(section).toContain("Known scope fits the export budgets");
    expect(section).toContain("Scope could not be checked");
    expect(section).toContain("No evidence exports yet");
    expect(section).not.toContain("Recent packages");
    expect(section).toContain("Limits dated evidence; current Records are always included.");
    expect(section).toContain("Package details");
    expect(section).toContain("Copy command");
    expect(section).toContain("cld grids evidence verify");
    expect(section).toContain("--manifest-sha256");
    expect(section).toContain("<DescriptionList");
    expect(section).toContain("<StatGrid");
    expect(section).not.toContain("<details");
    expect(section).toContain("Packages expire after seven days");
    expect(section).toContain('item.status === "failed" || item.status === "canceled"');
    expect(section).toContain('item.status === "queued" || item.status === "running"');
  });
});
