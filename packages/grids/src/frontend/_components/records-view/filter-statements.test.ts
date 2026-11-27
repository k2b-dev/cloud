import { describe, expect, test } from "bun:test";
import type { PublicField } from "../../../api/public-dto";
import { field } from "../table/database-table.fixture-data";
import { joinFilter, recordsFilterStatements, splitFilter, statementKey } from "./filter-statements";
import { buildRecordsUrl, parseRecordsState, type RecordsState } from "./query-url";

const fields: PublicField[] = [
  field({ id: "title", name: "Titel", type: "text", position: 0 }),
  field({
    id: "state",
    name: "Status",
    type: "select",
    position: 1,
    config: {
      options: [
        { id: "open", label: "Offen" },
        { id: "done", label: "Erledigt" },
      ],
    },
  }),
  field({ id: "amount", name: "Betrag", type: "number", position: 2 }),
  field({ id: "due", name: "Fällig", type: "date", position: 3 }),
  field({ id: "paid", name: "Bezahlt", type: "boolean", position: 4 }),
  field({ id: "owner", name: "Zuständig", type: "principal", position: 5 }),
];
const statements = recordsFilterStatements(fields, "de");
const path = { baseId: "B1", tableId: "T1", viewId: null };
const state = (filter: unknown): RecordsState => ({
  query: { filter: filter as RecordsState["query"]["filter"] },
  cursor: null,
  selectedRecordId: null,
  search: { q: "", fieldIds: [], override: false },
  calendar: { view: "month", date: new Date().toISOString().slice(0, 10) },
  cardSize: "medium",
});

describe("records filter statements", () => {
  test("simple leaves become statements; other verbs, second leaves and people stay for the dialog", () => {
    const leaves = [
      { fieldId: "title", op: "contains", value: "Dach" },
      { fieldId: "title", op: "startsWith", value: "A" },
      { fieldId: "state", op: "isAnyOf", value: ["open"] },
      { fieldId: "amount", op: "between", value: [100, 500] },
      { fieldId: "due", op: "thisWeek" },
      { fieldId: "paid", op: "=", value: false },
      { fieldId: "owner", op: "containsAny", value: ["u1"] },
      { fieldId: "amount", op: "isEmpty" },
    ];
    const { state: bar, rest } = splitFilter(statements, { op: "AND", filters: leaves } as never);
    expect(Object.keys(bar.filters)).toEqual([
      statementKey("title"),
      statementKey("state"),
      statementKey("amount"),
      statementKey("due"),
      statementKey("paid"),
    ]);
    expect(rest).toEqual([leaves[1]!, leaves[6]!, leaves[7]!]);
    // joining gives the same leaves back, the statements first
    const joined = joinFilter(statements, bar, rest ?? []) as { filters: unknown[] };
    expect(joined.filters).toHaveLength(leaves.length);
    expect(joined.filters).toContainEqual({ fieldId: "amount", op: "between", value: [100, 500] });
    expect(joined.filters).toContainEqual({ fieldId: "due", op: "thisWeek" });
  });

  test("open date ranges keep their day across the exclusive operators", () => {
    const { state: bar } = splitFilter(statements, { op: "AND", filters: [{ fieldId: "due", op: "after", value: "2026-11-30" }] } as never);
    expect(bar.filters[statementKey("due")]).toEqual({ kind: "range", from: "2026-12-01" });
    expect(joinFilter(statements, bar, [])).toEqual({ op: "AND", filters: [{ fieldId: "due", op: "after", value: "2026-11-30" }] });
  });

  test("the address holds statements as their own parameters and the rest as filter JSON, and reads both back", () => {
    const filter = {
      op: "AND",
      filters: [
        { fieldId: "state", op: "isAnyOf", value: ["open", "done"] },
        { fieldId: "title", op: "regex", value: "^A" },
      ],
    };
    const href = buildRecordsUrl(path, state(filter), null, statements);
    const params = new URL(href, "http://x").searchParams;
    expect(params.get(statementKey("state"))).toBe("open,done");
    expect(JSON.parse(params.get("filter") ?? "null")).toEqual({ op: "AND", filters: [filter.filters[1]] });
    const read = parseRecordsState(params, statements).query.filter as { filters: unknown[] };
    expect(read.filters).toContainEqual(filter.filters[0]);
    expect(read.filters).toContainEqual(filter.filters[1]);
  });

  test("an old address with every leaf in filter JSON keeps working", () => {
    const old = new URLSearchParams({ filter: JSON.stringify({ op: "AND", filters: [{ fieldId: "paid", op: "=", value: true }] }) });
    expect(parseRecordsState(old, statements).query.filter).toEqual({ op: "AND", filters: [{ fieldId: "paid", op: "=", value: true }] });
  });

  test("a saved view keeps its whole filter in the address as before", () => {
    const filter = { op: "AND", filters: [{ fieldId: "paid", op: "=", value: true }] };
    const href = buildRecordsUrl({ ...path, viewId: "V1" }, state(filter), { filter: undefined } as never, statements);
    expect(new URL(href, "http://x").searchParams.has(statementKey("paid"))).toBe(false);
  });
});
