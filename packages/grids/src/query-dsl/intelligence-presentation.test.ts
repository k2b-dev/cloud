import { describe, expect, test } from "bun:test";
import { buildDslQueryIntelligence } from "./intelligence";
import { presentDslQueryCompletions } from "./intelligence-presentation";
import { ctx } from "./resolver-fixtures";

describe("GQL completion presentation", () => {
  test("localizes hints without changing GQL labels or edits", () => {
    const items = buildDslQueryIntelligence({ query: "", caret: 0, ctx: ctx() });
    const english = presentDslQueryCompletions(items, "en");
    const german = presentDslQueryCompletions(items, "de-CH");
    const enFrom = english.find((item) => item.label === "from table");
    const deFrom = german.find((item) => item.label === "from table");

    expect(enFrom?.detail).toBe("Choose a base table");
    expect(deFrom).toMatchObject({
      label: "from table",
      insertText: "from table ",
      detail: "Basistabelle auswählen",
      textEdit: enFrom?.textEdit,
    });
  });

  test("keeps technical field metadata unchanged", () => {
    const item = {
      label: "Amount",
      kind: "field" as const,
      insertText: "Amount",
      textEdit: { start: 0, end: 0, text: "Amount" },
      detail: "number · FAmount",
    };
    expect(presentDslQueryCompletions([item], "de-DE")[0]).toEqual(item);
  });
});
