import { describe, expect, test } from "bun:test";

describe("Retention policy settings contract", () => {
  test("states activation, consequences, bounds, and non-goals in user language", async () => {
    const source = await Bun.file(new URL("./RetentionPolicySection.tsx", import.meta.url)).text();
    for (const text of [
      "Base retention floor",
      "This floor only delays eligibility",
      "No minimum retention configured",
      "Minimum retention days",
      "Finalized Records and protected Files remain protected",
      "No destruction performed",
      "Remove minimum retention?",
      "Nothing is deleted now",
      "Loading retention policy",
      "Retention policy is unavailable",
      "Impact could not be calculated",
      "Retention preview",
      "Review Records",
      "Review Files",
      "Protected references excluded",
    ])
      expect(source).toContain(text);
  });

  test("loads the File ledger through query.create and keeps filtering on the API", async () => {
    const source = await Bun.file(new URL("./RetentionFilesDialog.tsx", import.meta.url)).text();
    for (const text of ["query.create", "DataTable", "minimumDays", "search", "status", "per_page", "Download File", "View File"])
      expect(source).toContain(text);
    expect(source).not.toContain(".filter(");
    expect(source).not.toContain('tone={row.status === "retained" ? "running"');
    expect(source).toContain("fillHeight");
    expect(source).toContain("<DataTable.Controls>");
    expect(source).toContain('<div class="w-full">');
    expect(source).not.toContain('class="min-w-56 flex-1"');
  });

  test("loads the Record review through query.create and delegates recovery to Trash", async () => {
    const source = await Bun.file(new URL("./RetentionRecordsDialog.tsx", import.meta.url)).text();
    for (const text of [
      "query.create",
      "DataTable",
      "minimumDays",
      "search",
      "status",
      "per_page",
      "Open in Trash",
      "trash=1",
      "fillHeight",
    ])
      expect(source).toContain(text);
    expect(source).not.toContain(".filter(");
    expect(source).not.toContain("mutation.create");
    expect(source).not.toContain("apiClient");
    expect(source).toContain("<DataTable.Controls>");
    expect(source).toContain('<div class="w-full">');
    expect(source).not.toContain('class="min-w-56 flex-1"');
  });

  test("uses the shared compact stats surface without decorative section rules", async () => {
    const source = await Bun.file(new URL("./RetentionPolicySection.tsx", import.meta.url)).text();
    expect(source).toContain("<StatGrid");
    expect(source).toContain("<StatCell");
    expect(source).toContain("<InlineGuidance");
    expect(source).not.toContain("<Paper");
    expect(source).not.toContain('class="max-w-sm"');
    expect(source).not.toContain("border-t");
    expect(source).not.toContain("border-y");
  });
});
