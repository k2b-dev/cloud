import { describe, expect, test } from "bun:test";
import { unwrap } from "@k2b/stdlib";
import { canonicalDocumentJson } from "./document-json";
import { type DocumentTableData, renderDocumentTableOutput } from "./document-table-output";

const column = (key: string, label = key, sqlType = "text") => ({ key, label, type: sqlType, sqlType });
const render = (data: DocumentTableData, output: Parameters<typeof renderDocumentTableOutput>[0]["output"]) =>
  renderDocumentTableOutput({ data, output, filename: `report.${output.kind}` });
const content = (result: ReturnType<typeof render>) => new TextDecoder().decode(unwrap(result).artifact.bytes);

describe("typed document table outputs", () => {
  test("JSON wraps typed rows with explicit metadata without double encoding or overwriting values", () => {
    const data = { columns: [column("q_col_0", "Amount", "numeric")], rows: [{ q_col_0: "12345678901234567890.50" }] };
    const result = render(data, {
      kind: "json",
      wrapper: { rowsKey: "items", values: { approved: true, note: null, labels: ["Travel"] } },
    });
    expect(JSON.parse(content(result))).toEqual({
      approved: true,
      note: null,
      labels: ["Travel"],
      items: [{ Amount: "12345678901234567890.50" }],
    });
    expect(JSON.parse(content(render({ ...data, rows: [] }, { kind: "json", wrapper: { rowsKey: "items" } })))).toEqual({ items: [] });
    expect(render(data, { kind: "json", wrapper: { rowsKey: "items", values: { items: [] } } }).ok).toBe(false);
    expect(render(data, { kind: "json", wrapper: { rowsKey: " ", values: {} } }).ok).toBe(false);
    expect(render(data, { kind: "json", wrapper: { rowsKey: "items", values: { bad: "\0" } } }).ok).toBe(false);
    expect(render(data, { kind: "json", wrapper: { rowsKey: "items", values: { huge: "x".repeat(5 * 1024 * 1024) } } }).ok).toBe(false);
    expect(content(render(data, { kind: "json", wrapper: { rowsKey: "__proto__" } }))).toBe(
      '{"__proto__":[{"Amount":"12345678901234567890.50"}]}',
    );
  });

  test("CSV selects and renames aliases without losing exact types or bypassing heading protection", () => {
    const data = {
      columns: [column("q_col_0", "Name"), column("q_col_1", "Amount", "numeric"), column("q_col_2", "Private")],
      rows: [{ q_col_0: "Example", q_col_1: "-12345678901234567890.50", q_col_2: "excluded" }],
    };
    const output = { kind: "csv" as const, columns: [{ source: "Amount", label: "=Total" }, { source: "Name" }] };
    const result = render(data, output);
    expect(content(result)).toBe("'=Total,Name\r\n-12345678901234567890.50,Example\r\n");
    expect(unwrap(result).protectedCells).toBe(1);
    for (const columns of [
      [],
      [{ source: "q_col_0" }],
      [{ source: "Missing" }],
      [{ source: "Name" }, { source: "Name", label: "Again" }],
      [
        { source: "Name", label: "Same" },
        { source: "Amount", label: "Same" },
      ],
      [{ source: "Name", label: " " }],
    ])
      expect(render(data, { kind: "csv", columns }).ok).toBe(false);
  });

  test("uses aliases and declared column order, preserving exact numbers and nulls", () => {
    const data = {
      columns: [column("b", "Amount", "numeric"), column("a", "Paid", "boolean"), column("c", "Note")],
      rows: [{ a: false, b: "12345678901234567890.50", c: null }],
    };
    expect(content(render(data, { kind: "json" }))).toBe('[{"Amount":"12345678901234567890.50","Paid":false,"Note":null}]');
    expect(content(render(data, { kind: "csv" }))).toBe("Amount,Paid,Note\r\n12345678901234567890.50,false,\r\n");
  });

  test("keeps dates as strings and nested values intact in JSON", () => {
    const data = {
      columns: [column("d", "Date", "date"), column("items", "Items", "json")],
      rows: [{ d: "2026-09-11", items: [{ label: "Travel", amount: "18.50", eligible: true, note: null }] }],
    };
    expect(JSON.parse(content(render(data, { kind: "json" })))).toEqual([
      { Date: "2026-09-11", Items: [{ label: "Travel", amount: "18.50", eligible: true, note: null }] },
    ]);
    expect(render(data, { kind: "csv" }).ok).toBe(false);
    expect(content(render(data, { kind: "csv", nestedValues: "json" }))).toContain('""amount"":""18.50""');
  });

  test("quotes CSV once, including custom delimiters, newlines and quotes", () => {
    expect(content(render({ columns: [column("a")], rows: [{ a: 'Über; "x"\nnext' }] }, { kind: "csv", delimiter: ";" }))).toBe(
      'a\r\n"Über; ""x""\nnext"\r\n',
    );
  });

  test("protects text and headings, but does not turn negative amounts into text", () => {
    const data = {
      columns: [column("a", "=HEADING"), column("b", "Amount", "numeric")],
      rows: [{ a: " =1+1", b: "-18.50" }],
    };
    const safe = render(data, { kind: "csv" });
    expect(content(safe)).toBe("'=HEADING,Amount\r\n' =1+1,-18.50\r\n");
    expect(unwrap(safe).protectedCells).toBe(2);
    const raw = render(data, { kind: "csv", textProtection: "raw" });
    expect(content(raw)).toBe("=HEADING,Amount\r\n =1+1,-18.50\r\n");
    expect(unwrap(raw).protectedCells).toBe(0);
  });

  test("does not allow a formula in a numeric column to bypass text protection", () => {
    for (const amount of ["=1+1", "-cmd", "NaN", "1e2", 1.1, Number.MAX_SAFE_INTEGER + 1, true]) {
      expect(render({ columns: [column("a", "Amount", "numeric")], rows: [{ a: amount }] }, { kind: "csv" }).ok).toBe(false);
    }
  });

  test("rejects duplicated aliases, keys and missing cells instead of dropping data", () => {
    for (const columns of [[column("a"), column("a", "other")], [column("a", "same"), column("b", "same")], [column("a", " ")]]) {
      expect(render({ columns, rows: [{ a: 1, b: 2 }] }, { kind: "json" }).ok).toBe(false);
    }
    expect(render({ columns: [column("a")], rows: [{}] }, { kind: "json" }).ok).toBe(false);
  });

  test("preserves an explicit empty selection and dangerous property names as data", () => {
    expect(content(render({ columns: [column("a")], rows: [] }, { kind: "json" }))).toBe("[]");
    expect(content(render({ columns: [column("a")], rows: [] }, { kind: "csv" }))).toBe("a\r\n");
    const data = { columns: [column("a", "__proto__")], rows: [{ a: "value" }] };
    expect(content(render(data, { kind: "json" }))).toBe('[{"__proto__":"value"}]');
  });

  test("rejects non-JSON and sparse array inputs rather than emitting null", () => {
    for (const value of [undefined, NaN, Infinity, new Date(), new Array(1)]) {
      expect(render({ columns: [column("a")], rows: [{ a: value }] }, { kind: "json" }).ok).toBe(false);
    }
    expect(() => canonicalDocumentJson({ items: new Array(1) })).toThrow();
  });

  test("returns localized row/column errors without disclosing the cell value", () => {
    const result = renderDocumentTableOutput({
      data: { columns: [column("b", "Freigabe", "boolean")], rows: [{ b: "secret" }] },
      output: { kind: "json" },
      filename: "report.json",
      locale: "de",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Zeile 1, Spalte „Freigabe“");
      expect(result.error.message).not.toContain("secret");
    }
  });
});
