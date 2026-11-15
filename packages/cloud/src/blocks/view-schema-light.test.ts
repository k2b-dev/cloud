import { describe, expect, test } from "bun:test";
import { BoundViewSchema, bindCheckedView } from "./view-schema-light";

// Browsers resolve the data paths of a view a server already checked, such as an Action's review before approval.
describe("browser view binding", () => {
  const review = { slots: { recipients: { people: [{ name: "Lea Berg" }, { name: "Tom Weber" }] } } };
  const view = {
    version: 1,
    blocks: [
      {
        kind: "Section",
        title: "An",
        children: [
          {
            kind: "Table",
            title: "Empfänger",
            columns: [{ path: ["name"], label: "Name" }],
            rows: { from: ["slots", "recipients", "people"] },
          },
        ],
      },
    ],
  };

  test("resolves a list path inside a section against the review", () => {
    const bound = bindCheckedView(view, review);
    expect(bound.blocks[0]).toMatchObject({
      kind: "Section",
      children: [{ kind: "Table", rows: [{ name: "Lea Berg" }, { name: "Tom Weber" }] }],
    });
  });

  test("keeps a view without paths as it is", () => {
    const plain = { version: 1, blocks: [{ kind: "Text", text: "Hallo" }] };
    expect(JSON.stringify(bindCheckedView(plain, {}))).toBe(JSON.stringify(plain));
  });

  test("refuses a path that does not lead to a list, and a value that is no view", () => {
    expect(() => bindCheckedView(view, { slots: {} })).toThrow("blocks_binding");
    expect(() => bindCheckedView({ version: 2, blocks: [] }, {})).toThrow("blocks_binding");
    expect(() => bindCheckedView(view, { slots: { recipients: { people: "Lea" } } })).toThrow("blocks_binding");
  });

  test("checks only the envelope of a view the server sent", () => {
    expect(BoundViewSchema.safeParse({ version: 1, blocks: [] }).success).toBe(true);
    expect(BoundViewSchema.safeParse({ version: 1 }).success).toBe(false);
  });
});
