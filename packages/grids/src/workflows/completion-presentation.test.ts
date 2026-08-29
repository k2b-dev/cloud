import { describe, expect, test } from "bun:test";
import { buildWorkflowManifestCompletions } from "@valentinkolb/cloud/workflows";
import { presentWorkflowCompletions } from "./completion-presentation";
import { gridsWorkflows } from "./module";

describe("workflow completion presentation", () => {
  test("localizes input and action explanations without changing YAML", () => {
    const inputs = buildWorkflowManifestCompletions("inputs:\n  item:\n    type: ", 27, gridsWorkflows);
    const actions = buildWorkflowManifestCompletions("steps:\n  - ", 11, gridsWorkflows);
    const germanInput = presentWorkflowCompletions(inputs, "de-CH").find((item) => item.label === "record");
    const englishAction = actions.find((item) => item.label === "sendEmail");
    const germanAction = presentWorkflowCompletions(actions, "de-DE").find((item) => item.label === "sendEmail");

    expect(germanInput?.detail).toBe("Ein Datensatz aus einer konfigurierten Tabelle.");
    expect(germanAction).toMatchObject({
      label: "sendEmail",
      insertText: englishAction?.insertText,
      textEdit: englishAction?.textEdit,
      detail: "Rendert eine Grids-E-Mail-Vorlage und stellt sie jedem Empfänger genau einmal zu.",
    });
  });

  test("localizes catalog kinds and preserves public ids", () => {
    const item = {
      label: "Orders",
      kind: "source" as const,
      insertText: "Orders",
      textEdit: { start: 0, end: 0, text: "Orders" },
      detail: "Table Tbl01",
    };
    expect(presentWorkflowCompletions([item], "de-CH")[0]).toEqual({ ...item, detail: "Tabelle Tbl01" });
  });

  test("covers every published input, trigger, and action explanation", () => {
    const descriptors = [...gridsWorkflows.manifest.inputs, ...gridsWorkflows.manifest.triggers, ...gridsWorkflows.manifest.actions];
    const items = descriptors.map((descriptor) => ({
      label: descriptor.kind,
      kind: "keyword" as const,
      insertText: descriptor.kind,
      textEdit: { start: 0, end: 0, text: descriptor.kind },
      detail: descriptor.description,
    }));
    const german = presentWorkflowCompletions(items, "de-CH");

    expect(german.map((item) => item.label)).toEqual(items.map((item) => item.label));
    for (const [index, item] of german.entries()) expect(item.detail).not.toBe(items[index]!.detail);
  });
});
