import { expect, test } from "bun:test";
import { CustomAppDefinitionSchema } from "./contracts";

const definition = () => ({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: "APP001",
  baseId: "BASE01",
  name: "Editor",
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Editor",
      rows: [
        {
          id: "main",
          columns: [
            {
              id: "main",
              span: 12,
              blocks: [
                { id: "form", type: "form", formId: "FORM01", actionsBlockId: "actions" },
                { id: "actions", type: "actions", actions: [{ id: "back", kind: "navigate", label: "Back", pageId: "home", params: {} }] },
              ],
            },
          ],
        },
      ],
    },
  ],
});

test("form action ownership is explicit and remains in the same column", () => {
  const source = CustomAppDefinitionSchema.parse(definition());
  expect(source.pages[0]?.rows[0]?.columns[0]?.blocks[0]).toHaveProperty("actionsBlockId", "actions");
  const column = source.pages[0]!.rows[0]!.columns[0]!;
  const form = column.blocks[0]!;
  column.blocks.push({ ...form, id: "another" });
  expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
  column.blocks.pop();
  const actions = column.blocks.pop()!;
  source.pages[0]!.rows[0]!.columns.push({ id: "other", span: 6, blocks: [actions] });
  column.span = 6;
  expect(CustomAppDefinitionSchema.safeParse(source).success).toBe(false);
});
