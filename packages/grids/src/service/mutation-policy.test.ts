import { describe, expect, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowIrStep, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { workflowMutatesTable } from "./mutation-policy";

const TABLE = "11111111-1111-4111-8111-111111111111";
const OTHER_TABLE = "22222222-2222-4222-8222-222222222222";

const action = (sourcePath: Array<string | number>, name: string, config: Record<string, WorkflowJsonValue>): WorkflowIrStep => ({
  kind: "action",
  action: name,
  config,
  sourcePath,
});

const plan = (steps: WorkflowIrStep[], bindings: Record<string, WorkflowJsonValue>): WorkflowBoundPlan => ({
  schemaVersion: 2,
  languageId: "grids",
  languageVersion: 1,
  sourceHash: "source",
  manifestHash: "manifest",
  catalogHash: "catalog",
  actionPolicies: {},
  inputs: [{ name: "items", type: "recordList", config: {} }],
  triggers: [],
  steps,
  bindings,
});

describe("mutation policy workflow impact", () => {
  test("finds nested updates through record-list aliases", () => {
    const candidate = plan(
      [
        {
          kind: "forEach",
          reference: "inputs.items",
          alias: "item",
          sourcePath: ["steps", 0],
          steps: [action(["steps", 0, "do", 0], "updateRecord", { record: "item", set: { Status: "Done" } })],
        },
      ],
      { "inputs.items.table": TABLE },
    );

    expect(workflowMutatesTable(candidate, TABLE)).toBe(true);
    expect(workflowMutatesTable(candidate, OTHER_TABLE)).toBe(false);
  });

  test("uses action-specific bindings instead of unrelated table ids", () => {
    const candidate = plan([action(["steps", 0], "createRecord", { table: "Other", values: { Name: "Test" } })], {
      "inputs.items.table": TABLE,
      "steps.0.createRecord.table": OTHER_TABLE,
    });

    expect(workflowMutatesTable(candidate, TABLE)).toBe(false);
    expect(workflowMutatesTable(candidate, OTHER_TABLE)).toBe(true);
  });

  test("finds every target in atomic record changes", () => {
    const candidate = plan(
      [
        action(["steps", 0], "atomicRecords", {
          changes: [
            { updateRecord: { record: "inputs.items", set: { Status: "Done" } } },
            { createRecord: { table: "Archive", values: { Name: "Copy" } } },
          ],
        }),
      ],
      {
        "inputs.items.table": TABLE,
        "steps.0.atomicRecords.changes.1.createRecord.table": OTHER_TABLE,
      },
    );

    expect(workflowMutatesTable(candidate, TABLE)).toBe(true);
    expect(workflowMutatesTable(candidate, OTHER_TABLE)).toBe(true);
  });
});
