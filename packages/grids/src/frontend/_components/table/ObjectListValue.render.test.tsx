import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ObjectListValue } from "./ObjectListValue";

const config = {
  fields: [
    { id: "Amount", name: "Amount", type: "number" },
    { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 999" } },
  ],
};
const render = (value: unknown, detail = true) => renderToString(() => createComponent(ObjectListValue, { value, config, detail }));

describe("ObjectListValue", () => {
  test("displays stored computed values without recalculating them", () => {
    const html = render([{ Amount: "1", Total1: "2" }]);
    expect(html).toContain("Total");
    expect(html).toContain(">2</dd>");
    expect(html).not.toContain("999");
    expect(html).not.toContain("<input");
  });
  test("keeps table cells compact and progressively discloses detail rows", () => {
    const rows = Array.from({ length: 26 }, () => ({ Amount: "1", Total1: "2" }));
    const compact = render(rows, false);
    expect(compact).toContain("26 rows");
    expect(compact).not.toContain("<dl");
    const detail = render(rows);
    expect(detail.match(/<section /g)?.length).toBe(25);
    expect(detail).toContain("Show more rows");
  });
  test("distinguishes empty lists from malformed snapshots", () => {
    expect(render([])).toContain("0 rows");
    expect(render([null])).toContain("This list cannot be displayed");
  });
  test("keeps exact decimal strings intact in detail views", () => {
    expect(render([{ Amount: "9007199254740993.25", Total1: "18014398509481986.50" }])).toContain("18014398509481986.50");
  });
});
