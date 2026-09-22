import { expect, test } from "bun:test";
import { documentProfiles, profileRegistry } from "../document-profiles";
import { validateDocumentArtifactDrafts } from "../service/document-artifact-drafts";

const context = { number: "REPORT-1", issuedAt: new Date("2026-09-11T12:00:00Z") };
const table = {
  columns: [
    { key: "label", label: "Description", type: "text", sqlType: "text" },
    { key: "amount", label: "Amount", type: "number", sqlType: "numeric" },
  ],
  rows: [{ label: "=unsafe()", amount: "12.30" }],
};

test("registered table profiles produce validated exact CSV and JSON artifacts", async () => {
  const registry = profileRegistry(documentProfiles);
  for (const kind of ["csv", "json"] as const) {
    const profile = registry.get(`grids.${kind}@1`);
    if (!profile) throw new Error("Missing table profile");
    const output = await profile.issue(profile.input.parse(table), context);
    const checked = validateDocumentArtifactDrafts(output.artifacts, profile.primaryArtifact);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw checked.error;
    expect(checked.data.primary.filename).toBe(`REPORT-1.${kind}`);
    if (!("bytes" in checked.data.primary)) throw new Error("Expected a buffered table artifact");
    const text = new TextDecoder().decode(checked.data.primary.bytes);
    expect(text).toContain("12.30");
    if (kind === "csv") {
      expect(text).toContain("'=unsafe()");
      expect(output.validationStatus).toBe("warning");
      expect(output.validationReport).toMatchObject({ rowCount: 1, protectedCells: 1 });
    } else {
      expect(JSON.parse(text)).toEqual([{ Description: "=unsafe()", Amount: "12.30" }]);
      expect(output.validationStatus).toBe("valid");
    }
    expect(profile.input.safeParse({ ...table, extra: true }).success).toBe(false);
  }
});

test("table profile options are explicit and do not alter JSON values", async () => {
  const profile = profileRegistry(documentProfiles).get("grids.csv@1");
  if (!profile) throw new Error("Missing CSV profile");
  const output = await profile.issue(
    profile.input.parse({ ...table, filename: "custom.csv", options: { delimiter: ";", textProtection: "raw" } }),
    context,
  );
  const artifact = output.artifacts[0];
  if (!artifact || !("bytes" in artifact)) throw new Error("Expected a buffered CSV artifact");
  expect(new TextDecoder().decode(artifact.bytes)).toBe("Description;Amount\r\n=unsafe();12.30\r\n");
  expect(output.artifacts[0]?.filename).toBe("custom.csv");
  expect(profile.input.safeParse({ ...table, options: { kind: "json" } }).success).toBe(false);
});
