import { describe, expect, test } from "bun:test";
import type { CustomAppDefinition } from "../../../custom-apps/contracts";
import {
  appendCustomAppBlockRow,
  customAppPageParameterUsage,
  moveCustomAppPage,
  removeCustomAppPageParameter,
  renameCustomAppPage,
  renameCustomAppPageParameter,
} from "./custom-app-builder-model";

const definition = (): CustomAppDefinition => ({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "Loans",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Home",
      navigation: { visible: true },
      parameters: {},
      rows: [
        {
          id: "home-row",
          columns: [
            {
              id: "home-column",
              span: 12,
              blocks: [
                {
                  id: "records",
                  type: "records",
                  searchable: true,
                  pageSize: 25,
                  source: { kind: "gql", query: "from table Loans" },
                  display: { kind: "table", columnIds: ["COL001"] },
                  rowNavigate: { kind: "navigate", pageId: "loan", history: "push", params: { loan_id: { source: "ROW", path: "id" } } },
                },
                {
                  id: "open",
                  type: "actions",
                  actions: [
                    {
                      id: "open-loan",
                      kind: "navigate",
                      label: "Open",
                      pageId: "loan",
                      history: "push",
                      params: { loan_id: { source: "RECORD", path: "id" } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "loan",
      title: "Loan",
      navigation: { visible: false },
      parameters: { loan_id: { type: "record", tableId: "TABLE1", required: true } },
      record: { tableId: "TABLE1", id: { source: "PARAMS", path: "loan_id" } },
      rows: [
        {
          id: "loan-row",
          columns: [
            {
              id: "loan-column",
              span: 12,
              blocks: [
                {
                  id: "loan-record",
                  type: "record",
                  fieldIds: ["FIELD1"],
                  editableFieldIds: [],
                },
                {
                  id: "loan-form",
                  type: "form",
                  formId: "FORM01",
                  fixedValues: { FIELD2: { source: "PARAMS", path: "loan_id" } },
                  onSuccessNavigate: { kind: "navigate", pageId: "loan", params: { loan_id: { source: "PARAMS", path: "loan_id" } } },
                },
                {
                  id: "loan-actions",
                  type: "actions",
                  actions: [
                    {
                      id: "run",
                      kind: "workflow",
                      label: "Run",
                      launcherId: "LAUNCH",
                      inputs: { loan: { source: "PARAMS", path: "loan_id" } },
                    },
                  ],
                },
                {
                  id: "loan-items",
                  type: "records",
                  searchable: true,
                  pageSize: 25,
                  source: { kind: "gql", query: "from table Items" },
                  display: { kind: "table", columnIds: [] },
                  rowActions: [
                    {
                      id: "reserve",
                      kind: "workflow",
                      label: "Reserve",
                      showLabel: true,
                      launcherId: "LAUN02",
                      inputs: { loan: { source: "PARAMS", path: "loan_id" }, item: { source: "ROW", path: "id" } },
                    },
                  ],
                },
                {
                  id: "related-items",
                  type: "referenced_records",
                  sourceTableId: "TABLE2",
                  relationFieldId: "FIELD3",
                  fieldIds: ["FIELD4"],
                  display: { kind: "table" },
                  searchable: true,
                  pageSize: 25,
                  rowActions: [
                    {
                      id: "review",
                      kind: "workflow",
                      label: "Review",
                      showLabel: true,
                      launcherId: "LAUN03",
                      inputs: { loan: { source: "PARAMS", path: "loan_id" }, item: { source: "ROW", path: "id" } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("App builder model", () => {
  test("appends a new block in its own full-width row", () => {
    const rows = definition().pages[0]!.rows;
    const block = { id: "notes", type: "markdown" as const, markdown: "Notes" };

    const next = appendCustomAppBlockRow(rows, block, { rowId: "notes-row", columnId: "notes-column" });

    expect(next).toHaveLength(rows.length + 1);
    expect(next[0]).toBe(rows[0]);
    expect(next.at(-1)).toEqual({
      id: "notes-row",
      columns: [{ id: "notes-column", span: 12, blocks: [block] }],
    });
  });

  test("renames a page and every navigation reference", () => {
    const renamed = renameCustomAppPage(definition(), "loan", "loan-detail");
    expect(renamed.pages.map((page) => page.id)).toEqual(["home", "loan-detail"]);
    const homeBlocks = renamed.pages[0]!.rows[0]!.columns[0]!.blocks;
    expect(homeBlocks[0]!.type === "records" ? homeBlocks[0]!.rowNavigate?.pageId : null).toBe("loan-detail");
    expect(
      homeBlocks[1]!.type === "actions" && homeBlocks[1]!.actions[0]?.kind === "navigate" ? homeBlocks[1]!.actions[0].pageId : null,
    ).toBe("loan-detail");
    const form = renamed.pages[1]!.rows[0]!.columns[0]!.blocks[1]!;
    expect(form.type === "form" ? form.onSuccessNavigate?.pageId : null).toBe("loan-detail");

    const startDefinition = definition();
    startDefinition.startPageId = "loan";
    expect(renameCustomAppPage(startDefinition, "loan", "loan-detail").startPageId).toBe("loan-detail");
  });

  test("renames a parameter and every source and target mapping", () => {
    const current = definition();
    current.pages[1]!.availableWhen = { query: "from table Loans where id = @params.loan_id" };
    current.pages[1]!.rows[0]!.columns[0]!.blocks[0]!.availableWhen = {
      query: "from table Loans where id = @params.loan_id",
    };
    const renamed = renameCustomAppPageParameter(current, "loan", "loan_id", "record_id");
    const page = renamed.pages[1]!;
    expect(page.parameters.record_id?.tableId).toBe("TABLE1");
    expect(page.record?.id.path).toBe("record_id");
    const records = renamed.pages[0]!.rows[0]!.columns[0]!.blocks[0]!;
    const form = page.rows[0]!.columns[0]!.blocks[1]!;
    const actions = page.rows[0]!.columns[0]!.blocks[2]!;
    expect(records.type === "records" ? records.rowNavigate?.params : {}).toHaveProperty("record_id");
    const formBinding = form.type === "form" ? form.fixedValues["FIELD2"] : null;
    expect(formBinding?.source === "PARAMS" ? formBinding.path : null).toBe("record_id");
    const workflowInput = actions.type === "actions" && actions.actions[0]?.kind === "workflow" ? actions.actions[0].inputs.loan : null;
    expect(workflowInput?.source === "PARAMS" ? workflowInput.path : null).toBe("record_id");
    expect(page.availableWhen?.query).toContain("@params.record_id");
    expect(page.rows[0]!.columns[0]!.blocks[0]!.availableWhen?.query).toContain("@params.record_id");
    const referenced = page.rows[0]!.columns[0]!.blocks.at(-1)!;
    const referencedInput = referenced.type === "referenced_records" ? referenced.rowActions?.[0]?.inputs.loan : null;
    expect(referencedInput?.source === "PARAMS" ? referencedInput.path : null).toBe("record_id");
  });

  test("reports usage before removing and reorders pages deterministically", () => {
    expect(customAppPageParameterUsage(definition(), "loan", "loan_id")).toEqual([
      "row navigation",
      "Navigate action target",
      "page record",
      "Form binding",
      "Form success navigation",
      "Workflow action input",
      "Row action input",
    ]);
    expect(removeCustomAppPageParameter(definition(), "loan", "loan_id").pages[1]!.parameters).toEqual({});
    expect(moveCustomAppPage(definition(), "loan", -1).pages.map((page) => page.id)).toEqual(["loan", "home"]);
  });
});

test("workflow success navigation follows page and source/target parameter renames", () => {
  const source = definition();
  const block = source.pages[1]!.rows[0]!.columns[0]!.blocks.find((item) => item.type === "actions");
  if (!block || block.type !== "actions") throw new Error("Actions required");
  const action = block.actions.find((item) => item.kind === "workflow");
  if (!action || action.kind !== "workflow") throw new Error("Workflow required");
  action.onSuccessNavigate = { kind: "navigate", pageId: "loan", params: { loan_id: { source: "PARAMS", path: "loan_id" } } };
  expect(customAppPageParameterUsage(source, "loan", "loan_id")).toContain("Workflow success navigation");
  const renamed = renameCustomAppPageParameter(renameCustomAppPage(source, "loan", "detail"), "detail", "loan_id", "item_id");
  const renamedBlock = renamed.pages[1]!.rows[0]!.columns[0]!.blocks.find((item) => item.type === "actions");
  if (!renamedBlock || renamedBlock.type !== "actions") throw new Error("Actions required");
  const renamedAction = renamedBlock.actions.find((item) => item.id === action.id);
  expect(renamedAction && "onSuccessNavigate" in renamedAction && renamedAction.onSuccessNavigate).toEqual({
    kind: "navigate",
    pageId: "detail",
    params: { item_id: { source: "PARAMS", path: "item_id" } },
  });
});
