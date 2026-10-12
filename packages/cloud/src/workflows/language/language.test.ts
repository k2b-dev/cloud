import { describe, expect, test } from "bun:test";
import { crypto } from "@k2b/stdlib";
import type { WorkflowLanguageManifest } from "../contracts";
import type { DefinedWorkflowModule } from "../module";
import { bindWorkflow, canonicalWorkflowJson, compileWorkflow, hashWorkflowJson, parseWorkflowYaml } from "./index";

const docs = { label: "Test", description: "Test descriptor" };

const manifest: WorkflowLanguageManifest = {
  id: "test-workflows",
  version: 1,
  inputs: [
    {
      ...docs,
      kind: "text",
      valueType: "string",
      config: {
        kind: "object",
        properties: {
          label: { kind: "string", minLength: 2, optional: true },
          required: { kind: "boolean", optional: true },
        },
      },
    },
    {
      ...docs,
      kind: "list",
      valueType: "value[]",
      config: {
        kind: "object",
        properties: { itemType: { kind: "string", enum: ["text", "number"] } },
      },
    },
  ],
  triggers: [
    {
      ...docs,
      kind: "schedule",
      eventValues: { occurredAt: "dateTime" },
      config: {
        kind: "object",
        properties: {
          cron: { kind: "string", minLength: 1 },
          timezone: { kind: "string", optional: true },
        },
      },
    },
  ],
  actions: [
    {
      ...docs,
      kind: "setVariable",
      effect: "pure",
      dryRun: "full",
      outputType: "value",
      config: {
        kind: "object",
        properties: {
          name: { kind: "string", format: "identifier" },
          value: { kind: "value" },
        },
      },
    },
    {
      ...docs,
      kind: "notify",
      effect: "durable-intent",
      dryRun: "validate",
      config: {
        kind: "object",
        properties: {
          target: { kind: "string", format: "uri" },
          message: { kind: "string", minLength: 1 },
        },
      },
    },
  ],
  limits: { maxInputs: 5, maxSteps: 20, maxDepth: 4, maxConditions: 20, maxConditionDepth: 4, maxLoopItems: 100 },
};

const workflowsWithManifest = (value: WorkflowLanguageManifest): DefinedWorkflowModule => ({
  actions: {},
  manifest: value,
});

const workflows = workflowsWithManifest(manifest);

const directSource = `inputs:
  title:
    type: text
    required: true
steps:
  - setVariable:
      value: hello
      name: result
`;

const compileOk = async (source: string) => {
  const result = await compileWorkflow(source, workflows);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("\n"));
  return result.ir;
};

describe("strict workflow YAML", () => {
  test("rejects duplicate keys, aliases, anchors, and non-object roots", () => {
    const duplicate = parseWorkflowYaml("steps: []\nsteps: []\n");
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics[0]?.code).toBe("yaml.parse");
      expect(duplicate.diagnostics[0]?.location).toMatchObject({ line: 2, column: 1 });
    }

    const alias = parseWorkflowYaml("value: &shared yes\ncopy: *shared\n");
    expect(alias.ok).toBe(false);
    if (!alias.ok) expect(alias.diagnostics.map((item) => item.code)).toEqual(["yaml.anchor", "yaml.alias"]);

    const scalar = parseWorkflowYaml("just text");
    expect(scalar.ok).toBe(false);
    if (!scalar.ok) expect(scalar.diagnostics[0]?.code).toBe("workflow.root");
  });

  test("reports strict schema diagnostics at source locations", async () => {
    const source = `name: forbidden
inputs:
  title:
    type: text
    typo: true
steps:
  - setVariable:
      name: invalid-name
      value: ok
`;
    const result = await compileWorkflow(source, workflows);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual(
      expect.arrayContaining([
        { code: "schema.unknown", path: ["name"] },
        { code: "schema.unknown", path: ["inputs", "title", "typo"] },
        { code: "schema.format", path: ["steps", 0, "setVariable", "name"] },
      ]),
    );
    const typo = result.diagnostics.find((item) => item.path.join(".") === "inputs.title.typo");
    expect(typo?.location).toEqual({ offset: source.indexOf("typo"), line: 5, column: 5 });
  });
});

describe("workflow compilation", () => {
  test("compiles direct-only workflows with normalized IR and source locations", async () => {
    const ir = await compileOk(directSource);
    expect(ir).toMatchObject({
      schemaVersion: 1,
      languageId: "test-workflows",
      languageVersion: 1,
      inputs: [{ name: "title", type: "text", config: { required: true } }],
      triggers: [],
      steps: [{ kind: "action", action: "setVariable", config: { name: "result", value: "hello" }, sourcePath: ["steps", 0] }],
    });
    expect(ir.sourceHash).toBe(await crypto.common.hash(directSource));
    expect(ir.manifestHash).toBe(await hashWorkflowJson(manifest));
    expect(ir.sourceLocations["steps.0"]).toMatchObject({ line: 6, column: 5 });
  });

  test("allows omitted triggers, rejects empty triggers, and compiles trigger bindings", async () => {
    expect((await compileWorkflow(directSource, workflows)).ok).toBe(true);

    const empty = await compileWorkflow("triggers: {}\nsteps:\n  - setVariable: { name: result, value: ok }\n", workflows);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.diagnostics[0]?.code).toBe("trigger.empty");

    const triggered = await compileOk(`inputs:
  runAt:
    type: text
triggers:
  schedule:
    timezone: Europe/Berlin
    cron: "0 8 * * *"
    with:
      runAt: "\${{ trigger.occurredAt }}"
steps:
  - setVariable: { name: result, value: ok }
`);
    expect(triggered.triggers).toEqual([
      {
        kind: "schedule",
        config: { cron: "0 8 * * *", timezone: "Europe/Berlin" },
        with: { runAt: "${{ trigger.occurredAt }}" },
      },
    ]);
  });

  test("normalizes if, switch, and forEach control flow", async () => {
    const ir = await compileOk(`inputs:
  items:
    type: list
    itemType: text
steps:
  - if:
      equals: [one, one]
    then:
      - setVariable: { name: matched, value: true }
    else:
      - setVariable: { name: matched, value: false }
  - switch: "\${{ matched }}"
    cases:
      - when: true
        do:
          - notify: { target: "https://example.test/hook", message: matched }
    default:
      - setVariable: { name: fallback, value: true }
  - forEach: inputs.items
    as: item
    do:
      - setVariable: { name: current, value: "\${{ item }}" }
`);
    expect(ir.steps.map((step) => step.kind)).toEqual(["if", "switch", "forEach"]);
    expect(ir.steps[0]).toMatchObject({
      kind: "if",
      condition: { operator: "equals", operands: ["one", "one"] },
      then: [{ kind: "action", action: "setVariable" }],
      else: [{ kind: "action", action: "setVariable" }],
    });
    expect(ir.steps[1]).toMatchObject({ kind: "switch", value: "${{ matched }}", cases: [{ when: true }], default: [{}] });
    expect(ir.steps[2]).toMatchObject({ kind: "forEach", reference: "inputs.items", alias: "item", steps: [{}] });
  });

  test("compiles recursive boolean and text conditions", async () => {
    const ir = await compileOk(`steps:
  - if:
      all:
        - contains: ["\${{ inputs.subject }}", "STRASSE"]
        - includes: [[urgent, finance], finance]
        - textEquals: ["\${{ inputs.sender }}", "PERSON@EXAMPLE.COM"]
        - not:
            any:
              - startsWith: ["\${{ inputs.subject }}", spam]
              - endsWith: ["\${{ inputs.subject }}", trash]
    then:
      - setVariable: { name: matched, value: true }
`);

    expect(ir.steps[0]).toMatchObject({
      kind: "if",
      condition: {
        operator: "all",
        conditions: [
          { operator: "contains", operands: ["${{ inputs.subject }}", "STRASSE"] },
          { operator: "includes", operands: [["urgent", "finance"], "finance"] },
          { operator: "textEquals", operands: ["${{ inputs.sender }}", "PERSON@EXAMPLE.COM"] },
          {
            operator: "not",
            condition: {
              operator: "any",
              conditions: [
                { operator: "startsWith", operands: ["${{ inputs.subject }}", "spam"] },
                { operator: "endsWith", operands: ["${{ inputs.subject }}", "trash"] },
              ],
            },
          },
        ],
      },
    });
  });

  test("rejects empty recursive condition groups", async () => {
    const result = await compileWorkflow(
      "steps:\n  - if: { all: [] }\n    then:\n      - setVariable: { name: matched, value: true }\n",
      workflows,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "condition.conditions" }));
  });

  test("bounds recursive condition count and depth", async () => {
    const source = `steps:
  - if:
      all:
        - equals: [true, true]
        - not:
            equals: [false, true]
    then:
      - setVariable: { name: matched, value: true }
`;
    const countResult = await compileWorkflow(
      source,
      workflowsWithManifest({ ...manifest, limits: { ...manifest.limits, maxConditions: 2, maxConditionDepth: 10 } }),
    );
    const depthResult = await compileWorkflow(
      source,
      workflowsWithManifest({ ...manifest, limits: { ...manifest.limits, maxConditions: 10, maxConditionDepth: 2 } }),
    );

    expect(countResult.ok).toBe(false);
    if (!countResult.ok) expect(countResult.diagnostics).toContainEqual(expect.objectContaining({ code: "limit.conditions" }));
    expect(depthResult.ok).toBe(false);
    if (!depthResult.ok) expect(depthResult.diagnostics).toContainEqual(expect.objectContaining({ code: "limit.conditionDepth" }));
  });

  test("is deterministic while hashing the exact source", async () => {
    const first = await compileOk(directSource);
    const repeated = await compileOk(directSource);
    const reordered = await compileOk(
      directSource.replace("      value: hello\n      name: result", "      name: result\n      value: hello"),
    );
    expect(repeated).toEqual(first);
    expect(reordered.steps).toEqual(first.steps);
    expect(reordered.sourceHash).not.toBe(first.sourceHash);
  });

  test("rejects action descriptors that collide with control-flow names", async () => {
    const result = await compileWorkflow(
      directSource,
      workflowsWithManifest({ ...manifest, actions: [{ ...manifest.actions[0]!, kind: "if" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "manifest.reserved" }));
  });
});

describe("workflow catalog binding", () => {
  test("binds through one callback and hashes canonical manifest and catalog snapshots", async () => {
    const ir = await compileOk(directSource);
    let receivedIr: Readonly<typeof ir> | undefined;
    const first = await bindWorkflow(ir, workflows, (input) => {
      receivedIr = input;
      return {
        catalog: { resources: { second: "resource-2", first: "resource-1" }, revision: 4 },
        bindings: { target: "resource-1", action: "setVariable" },
      };
    });
    const repeated = await bindWorkflow(ir, workflows, () => ({
      catalog: { revision: 4, resources: { first: "resource-1", second: "resource-2" } },
      bindings: { action: "setVariable", target: "resource-1" },
    }));

    expect(receivedIr).toBe(ir);
    expect(repeated).toEqual(first);
    expect(Object.keys(first.bindings)).toEqual(["action", "target"]);
    expect(first).toMatchObject({
      schemaVersion: 2,
      languageId: "test-workflows",
      languageVersion: 1,
      sourceHash: ir.sourceHash,
      inputs: ir.inputs,
      triggers: ir.triggers,
      steps: ir.steps,
      actionPolicies: {
        setVariable: { effect: "pure", dryRun: "full" },
        notify: { effect: "durable-intent", dryRun: "validate" },
      },
    });
    expect(first.manifestHash).toHaveLength(64);
    expect(first.catalogHash).toHaveLength(64);
    expect(first.maxLoopItems).toBe(100);
  });

  test("rejects binding against a different manifest version", async () => {
    const ir = await compileOk(directSource);
    expect(bindWorkflow(ir, workflowsWithManifest({ ...manifest, version: 2 }), () => ({ catalog: {}, bindings: {} }))).rejects.toThrow(
      "does not match manifest",
    );
  });

  test("rejects binding against changed manifest content at the same version", async () => {
    const ir = await compileOk(directSource);
    let bindingCalled = false;
    await expect(
      bindWorkflow(ir, workflowsWithManifest({ ...manifest, limits: { ...manifest.limits, maxLoopItems: 99 } }), () => {
        bindingCalled = true;
        return { catalog: {}, bindings: {} };
      }),
    ).rejects.toThrow("manifest hash");
    expect(bindingCalled).toBe(false);
  });

  test("canonicalizes distinct Unicode keys independently of insertion order", () => {
    const composedFirst = { é: 1, "e\u0301": 2 };
    const decomposedFirst = { "e\u0301": 2, é: 1 };
    expect(canonicalWorkflowJson(composedFirst)).toBe(canonicalWorkflowJson(decomposedFirst));
  });
});

test("explains that switch cases require a non-empty entry list", async () => {
  for (const cases of ["{}", "[]", "{ one: [] }"]) {
    const result = await compileWorkflow(`steps:\n  - switch: one\n    cases: ${cases}\n`, workflows);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "switch.cases",
          message: "switch cases must be a non-empty list of { when, do } entries",
        }),
      );
  }
});
