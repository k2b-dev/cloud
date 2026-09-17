import { describe, expect, test } from "bun:test";
import { type CustomAppAction, CustomAppDefinitionSchema } from "./contracts";
import { customAppWorkflowSuccessParams } from "./workflow-navigation";

const target = CustomAppDefinitionSchema.parse({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "Billing",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Home",
      rows: [{ id: "row", columns: [{ id: "col", span: 12, blocks: [{ id: "info", type: "markdown", markdown: "Home" }] }] }],
    },
    {
      id: "bill",
      title: "Bill",
      navigation: { visible: false },
      parameters: { bill: { type: "record", tableId: "BILLS1", required: true } },
      rows: [{ id: "row", columns: [{ id: "col", span: 12, blocks: [{ id: "info", type: "markdown", markdown: "Bill" }] }] }],
    },
  ],
}).pages[1]!;
const navigation: NonNullable<Extract<CustomAppAction, { kind: "workflow" }>["onSuccessNavigate"]> = {
  kind: "navigate",
  pageId: "bill",
  params: { bill: { source: "RESULT", path: "recordId" } },
};

describe("workflow success navigation", () => {
  test("opens only a canonical public record result from the declared target table", () => {
    expect(customAppWorkflowSuccessParams(navigation, target, {}, { kind: "record", tableId: "BILLS1", recordId: "DRAFT1" })).toEqual({
      bill: "DRAFT1",
    });
    for (const result of [
      null,
      { recordId: "DRAFT1" },
      { kind: "record", tableId: "OTHER1", recordId: "DRAFT1" },
      { kind: "record", tableId: "BILLS1", recordId: "https://example.org" },
      { kind: "record", tableId: "BILLS1", recordId: "00000000-0000-4000-8000-000000000001" },
    ]) {
      expect(customAppWorkflowSuccessParams(navigation, target, {}, result)).toBeNull();
    }
  });
  test("supports a current page parameter without requiring a record workflow result", () => {
    const same = { ...navigation, params: { bill: { source: "PARAMS" as const, path: "bill_id" } } };
    expect(customAppWorkflowSuccessParams(same, target, { bill_id: "BILL01" }, null)).toEqual({ bill: "BILL01" });
    expect(customAppWorkflowSuccessParams(same, target, {}, null)).toBeNull();
  });
});

test("workflow navigation validates destination parameters and rejects arbitrary result paths", () => {
  const source = {
    schemaVersion: 5,
    kind: "grids.custom-app",
    id: "APP001",
    baseId: "BASE01",
    name: "Billing",
    startPageId: "home",
    pages: [
      {
        id: "home",
        title: "Home",
        rows: [
          {
            id: "row",
            columns: [
              {
                id: "col",
                span: 12,
                blocks: [
                  {
                    id: "actions",
                    type: "actions",
                    actions: [
                      {
                        id: "create",
                        kind: "workflow",
                        label: "Create",
                        launcherId: "LAUNCH",
                        variant: "primary",
                        onSuccessNavigate: navigation,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      target,
    ],
  };
  expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(true);
  const action = source.pages[0]!.rows[0]!.columns[0]!.blocks[0];
  if (!action || !("actions" in action)) throw new Error("Expected actions");
  const workflow = action.actions[0];
  if (!workflow || workflow.kind !== "workflow") throw new Error("Expected workflow");
  workflow.onSuccessNavigate = { ...navigation, pageId: "missing" };
  expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  workflow.onSuccessNavigate = { ...navigation, params: {} };
  expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  workflow.onSuccessNavigate = { ...navigation, params: { bill: { source: "PARAMS", path: "undeclared" } } };
  expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  const unknownOutput = JSON.parse(JSON.stringify(source));
  unknownOutput.pages[0].rows[0].columns[0].blocks[0].actions[0].onSuccessNavigate = {
    ...navigation,
    params: { bill: { source: "RESULT", path: "response.url" } },
  };
  expect(CustomAppDefinitionSchema.safeParse(unknownOutput).success).toBe(false);
});
