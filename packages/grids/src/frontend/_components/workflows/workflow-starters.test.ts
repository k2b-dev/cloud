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

  test("pins a correction Draft to one Record, its profile fields, and explicit prefill fields", () => {
    const starter = correctionDraftWorkflowStarter({
      table: { id: "TmZCsi", name: "Loan Items" },
      typeField: { id: "TyPe01" },
      typeValue: "correction",
      originalField: { id: "OrIg01" },
      copyFields: [{ id: "NaMe01" }, { id: "DaTe01" }],
    });

    expect(starter.source).toContain('table: "TmZCsi"');
    expect(starter.source).toContain("- createCorrectionDraft:");
    expect(starter.source).toContain('typeField: "TyPe01"');
    expect(starter.source).toContain('originalField: "OrIg01"');
    expect(starter.source).toContain('        - "NaMe01"');
    expect(starter.source).toContain('        - "DaTe01"');
    expect(starter.launcher.config).toEqual({ kind: "record", input: "original", profile: "correctionDraft" });
  });

  test("keeps starter launcher installation inside the editor save lifecycle", async () => {
    const editorSource = await Bun.file(new URL("./WorkflowEditor.tsx", import.meta.url)).text();
    const starterSource = await Bun.file(new URL("../sidebar/CreateWorkflowButton.island.tsx", import.meta.url)).text();

    expect(editorSource).toContain("if (props.beforeClose) await props.beforeClose(saved, { abortSignal })");
    expect(editorSource).toContain("onCleanup(() => saveMut.abort())");
    expect(starterSource).toContain(
      "beforeClose={starter ? (workflow, context) => installLauncher(workflow, starter, context.abortSignal) : undefined}",
    );
    expect(starterSource).not.toContain("void (async () =>");
  });
});
