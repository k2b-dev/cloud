import { describe, expect, test } from "bun:test";
import type { ColumnSpec, RecordMetaQuery } from "../../../contracts";
import { buildRecordsUrl, parseRecordsState, type RecordsState, type UrlPathContext } from "./query-url";

// =============================================================================
// query-url tests — URL ↔ RecordsState round-trip + path-based emit.
// =============================================================================
// The path segments (`/table/<id>` / `/view/<id>`) come from Hono
// route params, not URL search params, so parseRecordsState only deals
// with the query-param subset. buildRecordsUrl emits the full path-based
// shape; we check both pieces here.

const params = (s: string) => new URLSearchParams(s);

const path: UrlPathContext = {
  baseId: "BASE00",
  tableId: "TBL000",
  viewId: null,
};

const empty: RecordsState = {
  query: {},
  cursor: null,
  selectedRecordId: null,
  search: { q: "", fieldIds: [], override: false },
  calendar: { view: "month", date: new Date().toISOString().slice(0, 10) },
  cardSize: "medium",
};

const fieldId = "11111111-1111-4111-8111-111111111111";
const computedColumns: ColumnSpec[] = [
  { fieldId },
  {
    kind: "computed",
    id: "computed_total1",
    label: "Total",
    expression: "#price * #qty",
  },
];

describe("parseRecordsState", () => {
  test("empty params → empty state", () => {
    expect(parseRecordsState(params(""))).toEqual(empty);
  });

  test("filter param parsed", () => {
    const url = params("filter=" + encodeURIComponent('{"op":"AND","filters":[]}'));
    const r = parseRecordsState(url);
    expect(r.query.filter).toEqual({ op: "AND", filters: [] });
  });

  test("record metadata param parsed", () => {
    const meta: RecordMetaQuery = {
      users: { createdBy: ["11111111-1111-4111-8111-111111111111"] },
    };
    const r = parseRecordsState(params("meta=" + encodeURIComponent(JSON.stringify(meta))));
    expect(r.query.recordMeta).toEqual(meta);
  });

  test("Finalization metadata state is parsed without actor filters", () => {
    const meta: RecordMetaQuery = { finalizationStates: ["awaitingReview"] };
    const r = parseRecordsState(params("meta=" + encodeURIComponent(JSON.stringify(meta))));
    expect(r.query.recordMeta).toEqual(meta);
  });

  test("malformed filter → silently dropped (no throw)", () => {
    const r = parseRecordsState(params("filter=not-json"));
    expect(r.query.filter).toBeUndefined();
  });

  test("sort param parsed (array shape)", () => {
    const url = params("sort=" + encodeURIComponent('[{"fieldId":"f1","direction":"asc"}]'));
    const r = parseRecordsState(url);
    expect(r.query.sort).toEqual([{ fieldId: "f1", direction: "asc" }]);
  });

  test("record metadata sort param parsed", () => {
    const url = params("sort=" + encodeURIComponent('[{"source":"record","key":"updatedAt","direction":"desc"}]'));
    const r = parseRecordsState(url);
    expect(r.query.sort).toEqual([{ source: "record", key: "updatedAt", direction: "desc" }]);
  });

  test("groupSort param parsed", () => {
    const url = params("groupSort=" + encodeURIComponent('[{"fieldId":"*","agg":"count","direction":"desc"}]'));
    const r = parseRecordsState(url);
    expect(r.query.groupSort).toEqual([{ fieldId: "*", agg: "count", direction: "desc" }]);
  });

  test("columns param parsed for ad-hoc computed columns", () => {
    const r = parseRecordsState(params("columns=" + encodeURIComponent(JSON.stringify(computedColumns))));
    expect(r.query.columns).toEqual(computedColumns);
  });

  test("malformed columns entries are dropped", () => {
    const r = parseRecordsState(
      params("columns=" + encodeURIComponent(JSON.stringify([{ fieldId }, { kind: "computed", id: "bad", label: "", expression: "" }]))),
    );
    expect(r.query.columns).toEqual([{ fieldId }]);
  });

  test("trash=1 → deletedOnly: true", () => {
    expect(parseRecordsState(params("trash=1")).query.deletedOnly).toBe(true);
    expect(parseRecordsState(params("trash=1")).query.includeDeleted).toBeUndefined();
  });

  test("q + qFields parsed into search", () => {
    const r = parseRecordsState(params("q=hello&qFields=f1,f2"));
    expect(r.search).toEqual({ q: "hello", fieldIds: ["f1", "f2"], override: true });
  });

  test("cardSize parsed with invalid values falling back to medium", () => {
    expect(parseRecordsState(params("cardSize=small")).cardSize).toBe("small");
    expect(parseRecordsState(params("cardSize=large")).cardSize).toBe("large");
    expect(parseRecordsState(params("cardSize=giant")).cardSize).toBe("medium");
  });

  test("empty q is kept as an explicit search override", () => {
    const r = parseRecordsState(params("q="));
    expect(r.search).toEqual({ q: "", fieldIds: [], override: true });
  });

  test("table and view are not read from query parameters", () => {
    // These would resolve via c.req.param() at the SSR handler; the URL
    // parser is purely UI state on top of the resource the path identifies.
    const r = parseRecordsState(params("table=foo&view=bar"));
    expect(r).toEqual(empty);
  });
});

describe("buildRecordsUrl", () => {
  test("table-only path", () => {
    expect(buildRecordsUrl(path, empty)).toBe("/app/grids/BASE00/table/TBL000");
  });

  test("view path when viewId is set", () => {
    expect(buildRecordsUrl({ ...path, viewId: "VW0000" }, empty)).toBe("/app/grids/BASE00/table/TBL000/view/VW0000");
  });

  test("filter serialized as query param on top of the path", () => {
    const state: RecordsState = {
      ...empty,
      query: { filter: { op: "AND", filters: [] } },
    };
    const url = buildRecordsUrl(path, state);
    expect(url).toContain("/app/grids/BASE00/table/TBL000?");
    expect(url).toContain("filter=" + encodeURIComponent('{"op":"AND","filters":[]}'));
  });

  test("record metadata serialized as meta query param", () => {
    const state: RecordsState = {
      ...empty,
      query: {
        recordMeta: {
          users: { updatedBy: ["11111111-1111-4111-8111-111111111111"] },
        },
      },
    };
    const url = buildRecordsUrl(path, state);
    expect(url).toContain("meta=");
    expect(parseRecordsState(new URLSearchParams(url.split("?")[1])).query.recordMeta).toEqual(state.query.recordMeta);
  });

  test("groupSort serialized as query param", () => {
    const state: RecordsState = {
      ...empty,
      query: { groupSort: [{ fieldId: "*", agg: "count", direction: "desc" }] },
    };
    const url = buildRecordsUrl(path, state);
    expect(url).toContain("groupSort=" + encodeURIComponent('[{"fieldId":"*","agg":"count","direction":"desc"}]'));
  });

  test("columns serialized as query param", () => {
    const state: RecordsState = {
      ...empty,
      query: { columns: computedColumns },
    };
    const url = buildRecordsUrl(path, state);
    expect(parseRecordsState(new URLSearchParams(url.split("?")[1])).query.columns).toEqual(computedColumns);
  });

  test("view-matching fields are suppressed from the URL", () => {
    // Active view has a stored filter; state carries the SAME filter
    // (e.g. just-loaded URL). The output URL should omit it so the
    // view's stored value can flow through next render.
    const filter = { op: "AND" as const, filters: [] };
    const state: RecordsState = { ...empty, query: { filter } };
    const url = buildRecordsUrl({ ...path, viewId: "VW0000" }, state, { filter });
    expect(url).toBe("/app/grids/BASE00/table/TBL000/view/VW0000");
    expect(url).not.toContain("filter=");
  });

  test("view-matching record metadata is suppressed from the URL", () => {
    const recordMeta = { users: { deletedBy: ["11111111-1111-4111-8111-111111111111"] } };
    const state: RecordsState = { ...empty, query: { recordMeta } };
    const url = buildRecordsUrl({ ...path, viewId: "VW0000" }, state, { recordMeta });
    expect(url).toBe("/app/grids/BASE00/table/TBL000/view/VW0000");
  });

  test("view-matching search is suppressed from the URL", () => {
    const search = {
      q: "needle",
      fieldIds: ["11111111-1111-4111-8111-111111111111"],
    };
    const state: RecordsState = {
      ...empty,
      search: { ...search, override: false },
    };
    const url = buildRecordsUrl({ ...path, viewId: "VW0000" }, state, { search });
    expect(url).toBe("/app/grids/BASE00/table/TBL000/view/VW0000");
  });

  test("view-matching columns are suppressed from the URL", () => {
    const state: RecordsState = { ...empty, query: { columns: computedColumns } };
    const url = buildRecordsUrl({ ...path, viewId: "VW0000" }, state, { columns: computedColumns });
    expect(url).toBe("/app/grids/BASE00/table/TBL000/view/VW0000");
  });

  test("empty search override is emitted to clear a saved view search", () => {
    const url = buildRecordsUrl(
      { ...path, viewId: "VW0000" },
      { ...empty, search: { q: "", fieldIds: [], override: true } },
      { search: { q: "needle" } },
    );
    expect(url).toBe("/app/grids/BASE00/table/TBL000/view/VW0000?q=");
  });

  test("trash=1 emitted when deletedOnly is true", () => {
    const state: RecordsState = { ...empty, query: { deletedOnly: true } };
    const url = buildRecordsUrl(path, state);
    expect(url).toContain("trash=1");
  });

  test("record param emitted from selectedRecordId (detail panel)", () => {
    const state: RecordsState = { ...empty, selectedRecordId: "rec-123" };
    const url = buildRecordsUrl(path, state);
    expect(url).toContain("record=rec-123");
  });

  test("non-default cardSize emitted as query param", () => {
    const state: RecordsState = { ...empty, cardSize: "small" };
    const url = buildRecordsUrl(path, state);
    expect(url).toContain("cardSize=small");
    expect(parseRecordsState(new URLSearchParams(url.split("?")[1])).cardSize).toBe("small");
  });
});
