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
      intent: "correction",
      typeField: { id: "TyPe01" },
      typeValue: "correction",
      originalField: { id: "OrIg01" },
      copyFields: [{ id: "NaMe01" }, { id: "DaTe01" }],
    });

    expect(starter.source).toContain('table: "TmZCsi"');
    expect(starter.source).toContain("- createCorrectionDraft:");
    expect(starter.source).toContain("intent: correction");
    expect(starter.source).toContain('typeField: "TyPe01"');
    expect(starter.source).toContain('originalField: "OrIg01"');
    expect(starter.source).toContain('        - "NaMe01"');
    expect(starter.source).toContain('        - "DaTe01"');
    expect(starter.name).toBe("Create Loan Items correction Draft");
    expect(starter.launcher.config).toEqual({ kind: "record", input: "original", profile: "correctionDraft", intent: "correction" });
  });

  test("binds cancellation wording to the linked-Draft workflow plan", () => {
    const starter = correctionDraftWorkflowStarter({
      table: { id: "TmZCsi", name: "Loan Items" },
      intent: "cancellation",
      typeField: { id: "TyPe01" },
      typeValue: "cancelled",
      originalField: { id: "OrIg01" },
      copyFields: [],
    });

    expect(starter.name).toBe("Create Loan Items cancellation Draft");
    expect(starter.launcher.name).toBe("Create cancellation");
    expect(starter.launcher.config).toEqual({ kind: "record", input: "original", profile: "correctionDraft", intent: "cancellation" });
    expect(starter.source).toContain("- createCorrectionDraft:");
    expect(starter.source).toContain("intent: cancellation");
    expect(starter.source).toContain('typeValue: "cancelled"');
  });

  test("keeps starter launcher installation inside the editor save lifecycle", async () => {
    const editorSource = await Bun.file(new URL("./WorkflowEditor.tsx", import.meta.url)).text();
    const starterSource = await Bun.file(new URL("../sidebar/CreateWorkflowButton.island.tsx", import.meta.url)).text();

    expect(editorSource).toContain("if (props.beforeClose) await props.beforeClose(saved, { abortSignal })");
    expect(editorSource).toContain("triggerValidationMut.abort()");
    expect(editorSource).toContain("if (!confirmed || disposed) return");
    expect(starterSource).toContain(
      "beforeClose={starter ? (workflow, context) => installLauncher(workflow, starter, context.abortSignal) : undefined}",
    );
    expect(starterSource).not.toContain("void (async () =>");
  });

  test("lets an admin choose correction or cancellation without promising cancellation calculations", async () => {
    const starterSource = await Bun.file(new URL("../sidebar/CreateWorkflowButton.island.tsx", import.meta.url)).text();
    const launcherSource = await Bun.file(new URL("./WorkflowLauncherManager.tsx", import.meta.url)).text();

    expect(starterSource).toContain('label="Action"');
    expect(starterSource).toContain('id: "cancellation"');
    expect(starterSource).toContain("Grids creates and links the Draft");
    expect(starterSource).toContain("It does not calculate amounts, taxes, or counter-bookings");
    expect(launcherSource).toContain('label="Action"');
    expect(launcherSource).toContain("correctionDraftPlanIntent(props.workflow.plan, input())");
    expect(launcherSource).toContain("Defined by the workflow so the wording and stored follow-up type cannot disagree.");
  });

  test("aborts launcher manager requests when their owner closes", async () => {
    const source = await Bun.file(new URL("./WorkflowLauncherManager.tsx", import.meta.url)).text();

    expect(source).toContain("loadMut.abort()");
    expect(source).toContain("saveMut.abort()");
    expect(source).toContain("removeMut.abort()");
    expect(source).toContain("if (disposed) return");
  });
});
