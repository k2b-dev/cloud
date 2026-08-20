import { describe, expect, test } from "bun:test";
import { type GridsWorkflow, GridsWorkflowLauncherConfigSchema } from "../workflows/contracts";
import { validateLauncherConfig } from "./workflow-launchers";

const workflow = {
  plan: {
    inputs: [
      { name: "message", type: "text", config: { required: true } },
      { name: "count", type: "number", config: {} },
    ],
  },
} as GridsWorkflow;

describe("workflow launcher validation", () => {
  const closeSelectionWorkflow = (): GridsWorkflow =>
    ({
      plan: {
        inputs: [
          { name: "records", type: "recordList", config: { required: true } },
          { name: "closeMode", type: "text", config: { required: true } },
          { name: "closePolicyRevision", type: "number", config: { required: true } },
        ],
        triggers: [],
        steps: [
          {
            kind: "forEach",
            reference: "inputs.records",
            alias: "record",
            steps: [
              {
                kind: "action",
                action: "closeRecord",
                config: {
                  record: "record",
                  expectedMode: "inputs.closeMode",
                  expectedPolicyRevision: "inputs.closePolicyRevision",
                },
              },
            ],
          },
        ],
        bindings: { "inputs.records.table": "10000000-0000-4000-8000-000000000001" },
      },
    }) as unknown as GridsWorkflow;

  const closeSelectionConfig = { kind: "bulk", input: "records", profile: "closeSelection" } as const;

  test("keeps normal bulk launchers compatible and rejects the former combinable Close selection flags", () => {
    expect(GridsWorkflowLauncherConfigSchema.safeParse({ kind: "bulk", input: "records" }).success).toBe(true);
    expect(GridsWorkflowLauncherConfigSchema.safeParse(closeSelectionConfig).success).toBe(true);
    expect(
      GridsWorkflowLauncherConfigSchema.safeParse({
        kind: "bulk",
        input: "records",
        selection: "explicit",
        purpose: "closeSelection",
        modeInput: "closeMode",
      }).success,
    ).toBe(false);
  });

  test("accepts only the canonical Close selection plan", () => {
    expect(validateLauncherConfig(closeSelectionWorkflow(), closeSelectionConfig)).toEqual([]);
  });

  test("rejects an arbitrary workflow labeled as Close selection", () => {
    const candidate = closeSelectionWorkflow();
    const loop = candidate.plan.steps[0];
    if (loop?.kind !== "forEach" || loop.steps[0]?.kind !== "action") throw new Error("invalid fixture");
    loop.steps[0].action = "finalizeRecord";

    expect(validateLauncherConfig(candidate, closeSelectionConfig)).toEqual([
      expect.objectContaining({ code: "launcher.profile.plan" }),
    ]);
  });

  test("rejects an extended Close selection workflow", () => {
    const candidate = closeSelectionWorkflow();
    candidate.plan.inputs.push({ name: "note", type: "text", config: {} });

    expect(validateLauncherConfig(candidate, closeSelectionConfig)).toEqual([
      expect.objectContaining({ code: "launcher.profile.plan" }),
    ]);
  });

  test("rejects a Close selection workflow whose policy inputs are not bound to the action", () => {
    const candidate = closeSelectionWorkflow();
    const loop = candidate.plan.steps[0];
    if (loop?.kind !== "forEach" || loop.steps[0]?.kind !== "action") throw new Error("invalid fixture");
    loop.steps[0].config.expectedPolicyRevision = "inputs.closeMode";

    expect(validateLauncherConfig(candidate, closeSelectionConfig)).toEqual([
      expect.objectContaining({ code: "launcher.profile.plan" }),
    ]);
  });

  test("rejects launchers that cannot supply another required input", () => {
    const scannerWorkflow = {
      plan: {
        inputs: [
          { name: "record", type: "record", config: { required: true } },
          { name: "confirm", type: "boolean", config: { required: true } },
        ],
      },
    } as unknown as GridsWorkflow;

    expect(
      validateLauncherConfig(scannerWorkflow, {
        kind: "scanner",
        input: "record",
        resolve: { by: "scanCode" },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "launcher.input.unsupplied",
        message: 'scanner launcher cannot supply required workflow input "confirm"',
      }),
    ]);
  });

  test("accepts arbitrary staged scanner input names and validates each source against its input", () => {
    const stagedWorkflow = {
      plan: {
        inputs: [
          { name: "agreement", type: "record", config: { required: true } },
          { name: "asset", type: "record", config: { required: true } },
          { name: "assessment", type: "select", config: { required: true, options: ["good", "damaged"] } },
          { name: "operatorNote", type: "text", config: {} },
        ],
      },
    } as unknown as GridsWorkflow;

    expect(
      validateLauncherConfig(stagedWorkflow, {
        kind: "scanner",
        inputSources: {
          agreement: { kind: "session" },
          asset: { kind: "scan", value: "record", resolve: { by: "scanCode" } },
          assessment: { kind: "afterScan" },
          operatorNote: { kind: "fixed", value: "scanner station 1" },
        },
      }),
    ).toEqual([]);
  });

  test("rejects missing, mistyped, and multiple scan sources", () => {
    const stagedWorkflow = {
      plan: {
        inputs: [
          { name: "code", type: "text", config: { required: true } },
          { name: "confirm", type: "boolean", config: { required: true } },
        ],
      },
    } as unknown as GridsWorkflow;

    expect(
      validateLauncherConfig(stagedWorkflow, {
        kind: "scanner",
        inputSources: {
          code: { kind: "scan", value: "record", resolve: { by: "scanCode" } },
          other: { kind: "scan", value: "text" },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "launcher.scan.count" }),
        expect.objectContaining({ code: "launcher.input.type" }),
        expect.objectContaining({ code: "launcher.input.unknown" }),
        expect.objectContaining({ code: "launcher.input.unsupplied", message: expect.stringContaining('"confirm"') }),
      ]),
    );
  });

  test("requires complete type-safe Grids App input bindings", () => {
    expect(validateLauncherConfig(workflow, { kind: "customApp", inputMode: "fixed", inputBindings: { count: "many" } })).toEqual([
      expect.objectContaining({ code: "launcher.input.invalid", message: 'Workflow input "message" is required' }),
      expect.objectContaining({ code: "launcher.input.invalid", message: 'Workflow input "count" must be a finite number' }),
    ]);
    expect(
      validateLauncherConfig(workflow, {
        kind: "customApp",
        inputMode: "fixed",
        inputBindings: { message: "Run", count: 2 },
      }),
    ).toEqual([]);
  });

  test("accepts runtime input launchers without fixed values", () => {
    expect(validateLauncherConfig(workflow, { kind: "customApp", inputMode: "prompt" })).toEqual([]);
  });
});
