import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import { field, fields, records } from "./database-table.fixture-data";

const { default: DatabaseTable } = await import("./DatabaseTable");

const bodyCells = (html: string) => [
  ...html
    .split(/<tbody\b[^>]*>/)[1]!
    .split("</tr>")[0]!
    .matchAll(/<td\b[^>]*>/g),
];

describe("DatabaseTable columns (K7)", () => {
  test("the name column is the primary one, numbers stand right-aligned, and a phone list keeps name, a second value, and state", () => {
    const state = field({
      id: "state",
      name: "Zustand",
      type: "select",
      position: 12,
      config: { options: [{ id: "open", label: "Offen" }] },
    });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: {
          items: [{ ...records[0]!, data: { ...records[0]!.data, state: ["open"] } }],
          fields: [...fields, state],
          nextCursor: null,
        },
        baseId: "base",
      }),
    );
    const cells = bodyCells(html).map((cell) => cell[0]);
    const at = (id: string) => cells[[...fields, state].findIndex((entry) => entry.id === id)]!;
    expect(cells.filter((cell) => cell.includes("data-primary"))).toEqual([at("text")]);
    expect(at("text")).toContain('data-list="title"');
    expect(at("status")).toContain('data-list="meta"');
    expect(at("state")).toContain('data-list="end"');
    expect(at("number")).toContain('data-align="right"');
    expect(at("date")).not.toContain('data-align="right"');
    // One 36 px head line: the type lives in the icon, not in a second line under the name.
    expect(html).not.toContain("k2b-data-table__header-subtitle");
  });
});

describe("DatabaseTable wrapping", () => {
  test("keeps dates and amounts intact while text can wrap", () => {
    const html = renderToString(() =>
      createComponent(DatabaseTable, { result: { items: [records[0]!], fields, nextCursor: null }, baseId: "base" }),
    );
    const nowrap = bodyCells(html).map((cell) => cell[0].includes('data-nowrap="true"'));
    expect(nowrap).toEqual(fields.map((field) => ["number", "date", "formula"].includes(field.type)));
    expect(nowrap.filter(Boolean)).toHaveLength(3);
  });

  test("uses lookup display types and infers nowrap for computed numeric values", () => {
    const lookup = field({
      id: "lookup",
      name: "Due",
      type: "lookup",
      config: {
        __lookupTarget: { fieldId: "target", name: "Due", type: "date", config: {} },
      },
    });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { lookup: "2026-11-14", computed: 12400 } }], fields: [lookup], nextCursor: null },
        baseId: "base",
        viewColumns: [{ fieldId: "lookup" }, { kind: "computed", id: "computed", label: "Total", expression: "1 + 1" }],
      }),
    );
    expect(bodyCells(html).map((cell) => cell[0].includes('data-nowrap="true"'))).toEqual([true, true]);
  });

  test("keeps formula values with a field date format on one line", () => {
    const formula = field({
      id: "formula",
      name: "Due",
      type: "formula",
      config: { format: { kind: "date", format: "iso" } },
    });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { [formula.id]: "2026-11-14" } }], fields: [formula], nextCursor: null },
        baseId: "base",
      }),
    );
    expect(bodyCells(html)[0]![0]).toContain('data-nowrap="true"');
  });

  test("keeps formula values with a view-column decimal format on one line", () => {
    const formula = field({ id: "00000000-0000-4000-8000-000000000001", name: "Total", type: "formula" });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { [formula.id]: "12400.00" } }], fields: [formula], nextCursor: null },
        baseId: "base",
        viewColumns: [{ fieldId: formula.id, format: { kind: "decimal" } }],
      }),
    );
    expect(bodyCells(html)[0]![0]).toContain('data-nowrap="true"');
  });

  test.each(["count", "sum", "avg"])("keeps %s rollup string values on one line", (agg) => {
    const rollup = field({ id: "rollup", name: "Total", type: "rollup", config: { agg } });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: { items: [{ ...records[0]!, data: { [rollup.id]: "12400" } }], fields: [rollup], nextCursor: null },
        baseId: "base",
      }),
    );
    expect(bodyCells(html)[0]![0]).toContain('data-nowrap="true"');
  });

  // K1, K15: a row stays 40 px; long text is an excerpt of one line with an ellipsis (it used to wrap in the cell).
  test.each(["text", "longtext"] as const)("keeps long %s values to one line with an ellipsis", (type) => {
    const text = field({ id: "text", name: "Notes", type });
    const html = renderToString(() =>
      createComponent(DatabaseTable, {
        result: {
          items: [
            { ...records[0]!, data: { [text.id]: "A long description with enough detail to span several lines in a narrow column." } },
          ],
          fields: [text],
          nextCursor: null,
        },
        baseId: "base",
      }),
    );
    expect(bodyCells(html)[0]![0]).not.toContain("data-wrap");
    expect(html).toContain('<div class="k2b-data-table__cell-text">');
  });
});
