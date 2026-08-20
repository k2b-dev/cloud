import { describe, expect, test } from "bun:test";
import { closeSelectionWorkflowStarter, correctionDraftWorkflowStarter } from "./workflow-starters";

describe("workflow starters", () => {
  test("pins Close selection to an explicit record-list input", () => {
    const starter = closeSelectionWorkflowStarter({ id: "TmZCsi", name: "Loan Items" });

    expect(starter.source).toContain('table: "TmZCsi"');
    expect(starter.source).toContain("- closeRecord:");
    expect(starter.launcher.config).toEqual({
      kind: "bulk",
      input: "records",
      profile: "closeSelection",
    });
    expect(starter.source).toContain("expectedPolicyRevision: inputs.closePolicyRevision");
  });

  test("pins a correction Draft to one Record and two existing fields", () => {
    const starter = correctionDraftWorkflowStarter({
      table: { id: "TmZCsi", name: "Loan Items" },
      typeField: { id: "TyPe01" },
      typeValue: "correction",
      originalField: { id: "OrIg01" },
    });

    expect(starter.source).toContain('table: "TmZCsi"');
    expect(starter.source).toContain("- createCorrectionDraft:");
    expect(starter.source).toContain('typeField: "TyPe01"');
    expect(starter.source).toContain('originalField: "OrIg01"');
    expect(starter.launcher.config).toEqual({ kind: "record", input: "original", profile: "correctionDraft" });
  });
});
