import { expect, test } from "bun:test";
import { CustomAppDefinitionSchema } from "./contracts";

const definition = (source: unknown, display: unknown) => ({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "Orders",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Orders",
      rows: [{ id: "content", columns: [{ id: "main", span: 12, blocks: [{ id: "orders", type: "records", source, display }] }] }],
    },
  ],
});

test("table presentation accepts GQL aliases and validates View display references", () => {
  const display = {
    kind: "table",
    columnIds: [],
    relativeDateColumnIds: ["due_date"],
    mobile: { titleColumnId: "order_title", detailColumnIds: ["due_date", "amount"] },
  };
  expect(CustomAppDefinitionSchema.safeParse(definition({ kind: "gql", query: "from table Orders" }, display)).success).toBe(true);
  expect(
    CustomAppDefinitionSchema.safeParse(definition({ kind: "view", viewId: "VIEW01" }, { ...display, columnIds: ["FIELD1"] })).success,
  ).toBe(false);
  expect(
    CustomAppDefinitionSchema.safeParse(
      definition(
        { kind: "view", viewId: "VIEW01" },
        {
          kind: "table",
          columnIds: ["FIELD1", "FIELD2"],
          relativeDateColumnIds: ["FIELD2"],
          mobile: { titleColumnId: "FIELD1", detailColumnIds: ["FIELD2"] },
        },
      ),
    ).success,
  ).toBe(true);
});

test("table presentation rejects duplicate mobile and relative columns", () => {
  for (const presentation of [
    { relativeDateColumnIds: ["due", "due"] },
    { mobile: { titleColumnId: "title", detailColumnIds: ["title"] } },
    { mobile: { titleColumnId: "title", detailColumnIds: ["date", "date"] } },
  ])
    expect(
      CustomAppDefinitionSchema.safeParse(
        definition(
          { kind: "gql", query: "from table Orders" },
          {
            kind: "table",
            columnIds: [],
            ...presentation,
          },
        ),
      ).success,
    ).toBe(false);
});
