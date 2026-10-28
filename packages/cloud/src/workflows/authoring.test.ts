import { describe, expect, test } from "bun:test";
import { buildWorkflowManifestCompletions, workflowCompletionContext } from "./authoring";
import type { WorkflowLanguageManifest } from "./contracts";
import { parseWorkflowYaml } from "./language/strict-yaml";
import type { DefinedWorkflowModule } from "./module";

const manifest: WorkflowLanguageManifest = {
  id: "test",
  version: 1,
  inputs: [
    {
      kind: "message",
      label: "Message",
      description: "One message",
      valueType: "test.message",
      config: { kind: "object", properties: {} },
    },
  ],
  triggers: [
    {
      kind: "received",
      label: "Received",
      description: "A message arrived",
      snippet: "received:\n  with: {}",
      config: { kind: "object", properties: {} },
      eventValues: {},
    },
  ],
  actions: [
    {
      kind: "send",
      label: "Send",
      description: "Send a message",
      config: { kind: "object", properties: {} },
      effect: "ambiguous-external",
      dryRun: "validate",
    },
  ],
};

const workflows = {
  actions: {},
  manifest,
} satisfies DefinedWorkflowModule;

describe("workflow authoring completions", () => {
  test("replaces only the current YAML value", () => {
    const source = "steps:\n  - move:\n      folder: Inb";
    expect(workflowCompletionContext(source, source.length).range).toEqual({
      start: source.indexOf("Inb"),
      end: source.length,
    });
  });

  test("derives input, trigger, action, and root suggestions from the manifest", () => {
    expect(buildWorkflowManifestCompletions("inputs:\n  item:\n    type: mes", 29, workflows).map((item) => item.label)).toEqual([
      "message",
    ]);
    expect(buildWorkflowManifestCompletions("triggers:\n  ", 12, workflows).map((item) => item.label)).toEqual(["received"]);
    expect(buildWorkflowManifestCompletions("steps:\n  - se", 13, workflows).map((item) => item.label)).toEqual(["send"]);
    expect(buildWorkflowManifestCompletions("", 0, workflows).map((item) => item.label)).toEqual(["inputs", "triggers", "steps"]);
  });
});

test("suggests number comparisons in nested conditions", () => {
  for (const source of [
    "steps:\n  - if:\n      gr",
    "steps:\n  - if:\n      all:\n        - gr",
    "steps:\n  - if:\n      not:\n        gr",
  ]) {
    expect(buildWorkflowManifestCompletions(source, source.length, workflows).map((item) => item.label)).toEqual(
      expect.arrayContaining(["greaterThan", "lessThan", "atLeast", "atMost"]),
    );
  }
});

test("inline condition completions insert parseable flow mappings", () => {
  for (const prefix of ["steps:\n  - if: gr", "steps:\n  - if:\n      not: gr"]) {
    const item = buildWorkflowManifestCompletions(prefix, prefix.length, workflows).find((item) => item.label === "greaterThan");
    expect(item).toBeDefined();
    if (!item) throw new Error("Expected number operator completion");
    const edited = prefix.slice(0, item.textEdit.start) + item.textEdit.text + prefix.slice(item.textEdit.end);
    expect(parseWorkflowYaml(edited).ok).toBe(true);
    expect(edited).toEndWith("{ greaterThan: [] }");
  }
});

test("does not suggest condition keys in operand values or sibling step keys", () => {
  for (const source of [
    "steps:\n  - if:\n      greaterThan: gr",
    "steps:\n  - if:\n      equals: [1, 1]\n    then:",
    "steps:\n  - if:\n      equals: [1, 1]\n    th",
  ]) {
    expect(buildWorkflowManifestCompletions(source, source.length, workflows).some((item) => item.label === "greaterThan")).toBe(false);
  }
});
