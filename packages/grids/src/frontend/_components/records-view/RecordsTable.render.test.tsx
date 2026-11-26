import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import { field, fields, records } from "../table/database-table.fixture-data";

const { default: RecordsTable } = await import("./RecordsTable");
const { LocaleProvider } = await import("@k2b/ui");

const renderTable = (props: Partial<Parameters<typeof RecordsTable>[0]> = {}) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(RecordsTable, {
          items: records.slice(0, 2),
          fields,
          baseId: "base",
          fieldsByTable: {},
          relationLabels: {},
          selectedRecordId: null,
          recordHref: (record) => `/app/grids/base/table/table?record=${record.id}`,
          onOpenRecord: () => {},
          ...props,
        });
      },
    }),
  );

const heads = (html: string) => [...html.matchAll(/<th\b[^>]*>(?:<span[^>]*><\/span>)?([^<]*)/g)].map((match) => match[1]);

describe("records on v2", () => {
  test("one column per visible field in order, amounts and dates intact, each row opens its record", () => {
    const html = renderTable();
    expect(heads(html)).toEqual(fields.map((each) => each.name));
    expect(html).toContain("12400,00 EUR");
    expect(html).toContain("2026-11-14");
    expect(html).toContain("2026-12-01");
    expect(html).toContain('href="/app/grids/base/table/table?record=record-0"');
    // amounts stand at the end of their column
    expect(html).toMatch(/<th scope="col" data-align="end"[^>]*>(?:<span[^>]*><\/span>)?Betrag/);
    expect(html).not.toMatch(/\bclass="(?!k2-|ti )[^"]*"/);
  });

  test("a saved view's columns decide which fields show, their labels and order", () => {
    const html = renderTable({
      viewColumns: [
        { fieldId: "date", label: "Termin" },
        { fieldId: "text" },
        { kind: "computed", id: "c1", label: "Summe", expression: "1 + 1" },
      ],
    });
    expect(heads(html)).toEqual(["Termin", "Auftrag", "Summe"]);
  });

  test("lookups take the type of the field they show", () => {
    const lookup = field({
      id: "lookup",
      name: "Due",
      type: "lookup",
      config: { __lookupTarget: { fieldId: "target", name: "Due", type: "date", config: {} } },
    });
    const html = renderTable({ fields: [lookup], items: [{ ...records[0]!, data: { lookup: "2026-11-14" } }] });
    expect(html).toContain("2026-11-14");
  });

  test("the open record is tinted, the sort shows in its head, and a selection adds the box column", () => {
    const html = renderTable({
      selectedRecordId: "record-1",
      sort: [{ fieldId: "date", direction: "desc" }],
      onSort: () => {},
      bulkSelection: { selectedIds: new Set(["record-0"]), onToggleRecord: () => {}, onToggleVisible: () => {} },
    });
    expect(html).toContain('aria-sort="descending"');
    expect(html).toMatch(/type="checkbox"/);
    expect(html).toContain("Alle Datensätze");
  });

  test("no records: the empty state stands in place of the table", () => {
    const html = renderTable({ items: [], empty: { icon: "table", text: "Noch keine Datensätze." } });
    expect(html).toContain("Noch keine Datensätze.");
  });
});
