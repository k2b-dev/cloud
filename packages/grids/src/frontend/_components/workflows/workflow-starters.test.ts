import { describe, expect, test } from "bun:test";
import { closeSelectionWorkflowStarter } from "./workflow-starters";

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
});
