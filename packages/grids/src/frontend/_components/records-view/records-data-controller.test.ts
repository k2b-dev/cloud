import { describe, expect, test } from "bun:test";
import type { PublicGridRecord as GridRecord, PublicTableQueryResult as TableQueryResult } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";
import {
  fetchVisibleFlatRecords,
  fetchVisibleGroupedRecords,
  reconcileFlatRecordsPage,
  reconcileGroupedRecordsPage,
} from "./records-data-controller";
import { nextCursorWithinLimit, queryForRecordsPage } from "./records-pagination";

const record = (id: string): GridRecord => ({
  id,
  tableId: "table-1",
  data: {},
  version: 1,
  deletedAt: null,
  createdBy: null,
  updatedBy: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

describe("reconcileFlatRecordsPage", () => {
  test("replaces stale rows and previews with a new first page", () => {
    expect(
      reconcileFlatRecordsPage(
        { items: [record("old")], nextCursor: "old-cursor", filePreviews: { old: {} } },
        { items: [record("new")], nextCursor: "next", filePreviews: { new: {} } } as TableQueryResult,
        false,
      ),
    ).toEqual({ items: [record("new")], nextCursor: "next", filePreviews: { new: {} } });
  });

  test("appends unique rows and merges previews for pagination", () => {
    expect(
      reconcileFlatRecordsPage(
        { items: [record("a")], nextCursor: "page-2", filePreviews: { a: {} } },
        { items: [record("a"), record("b")], nextCursor: null, filePreviews: { b: {} } } as TableQueryResult,
        true,
      ),
    ).toEqual({ items: [record("a"), record("b")], nextCursor: null, filePreviews: { a: {}, b: {} } });
  });
});

describe("reconcileGroupedRecordsPage", () => {
  test("appends unique buckets and preserves labels across cursor pages", () => {
    expect(
      reconcileGroupedRecordsPage(
        {
          buckets: [{ keys: ["open"], values: { "*__count": 2 } }],
          nextCursor: "page-2",
          relationLabels: { a: "Alpha" },
          explode: false,
        },
        {
          buckets: [
            { keys: ["open"], values: { "*__count": 2 } },
            { keys: ["closed"], values: { "*__count": 1 } },
          ],
          nextCursor: null,
          relationLabels: { b: "Beta" },
          explode: true,
        },
        true,
      ),
    ).toEqual({
      buckets: [
        { keys: ["open"], values: { "*__count": 2 } },
        { keys: ["closed"], values: { "*__count": 1 } },
      ],
      nextCursor: null,
      relationLabels: { a: "Alpha", b: "Beta" },
      explode: true,
    });
  });

  test("stops exactly at an explicit query limit", () => {
    const current = {
      buckets: [{ keys: ["a"], values: {} }],
      nextCursor: "page-2",
      relationLabels: {},
      explode: false,
    };
    expect(
      reconcileGroupedRecordsPage(
        current,
        {
          buckets: [
            { keys: ["b"], values: {} },
            { keys: ["c"], values: {} },
          ],
          nextCursor: "page-3",
        } as TableQueryResult,
        true,
        2,
      ),
    ).toEqual({
      buckets: [
        { keys: ["a"], values: {} },
        { keys: ["b"], values: {} },
      ],
      nextCursor: null,
      relationLabels: {},
      explode: false,
    });
  });
});

describe("fetchVisibleFlatRecords", () => {
  test("loads enough cursor pages to preserve the visible slice", async () => {
    const cursors: Array<string | null> = [];
    const result = await fetchVisibleFlatRecords({
      source: {
        tableId: "table-1",
        query: {} as RecordQuery,
        cursor: null,
        filePreviewFieldIds: ["cover"],
        calendar: { view: "month", date: "2026-07-01" },
      },
      targetCount: 2,
      signal: new AbortController().signal,
      fetchRecords: async (args) => {
        cursors.push(args.cursor);
        return args.cursor
          ? ({ items: [record("b")], nextCursor: null, filePreviews: { b: {} }, relationLabels: { second: "Second" } } as TableQueryResult)
          : ({
              items: [record("a")],
              nextCursor: "page-2",
              filePreviews: { a: {} },
              relationLabels: { first: "First" },
              aggregates: { total: "120.50" },
            } as TableQueryResult);
      },
    });

    expect(cursors).toEqual([null, "page-2"]);
    expect(result.items).toEqual([record("a"), record("b")]);
    expect(result.filePreviews).toEqual({ a: {}, b: {} });
    expect(result.relationLabels).toEqual({ first: "First", second: "Second" });
    expect(result.aggregates).toEqual({ total: "120.50" });
  });
});

describe("fetchVisibleGroupedRecords", () => {
  test("reloads every visible group page instead of collapsing to page one", async () => {
    const cursors: Array<string | null> = [];
    const result = await fetchVisibleGroupedRecords({
      source: {
        tableId: "table-1",
        query: {} as RecordQuery,
        cursor: null,
        calendar: { view: "month", date: "2026-07-01" },
      },
      targetCount: 2,
      signal: new AbortController().signal,
      fetchRecords: async (args) => {
        cursors.push(args.cursor);
        return args.cursor
          ? ({ buckets: [{ keys: ["b"], values: {} }], nextCursor: null } as TableQueryResult)
          : ({ buckets: [{ keys: ["a"], values: {} }], nextCursor: "page-2", aggregates: { total: "120.50" } } as TableQueryResult);
      },
    });

    expect(cursors).toEqual([null, "page-2"]);
    expect(result.buckets).toEqual([
      { keys: ["a"], values: {} },
      { keys: ["b"], values: {} },
    ]);
    expect(result.aggregates).toEqual({ total: "120.50" });
  });
});

describe("records pagination limits", () => {
  test("live paging refuses repeating cursors rather than looping", async () => {
    let calls = 0;
    const source = { tableId: "table-1", query: {} as RecordQuery, cursor: null, calendar: { view: "month" as const, date: "2026-07-01" } };
    await expect(
      fetchVisibleFlatRecords({
        source,
        targetCount: 3,
        signal: new AbortController().signal,
        fetchRecords: async () => {
          calls++;
          return { items: [], nextCursor: "repeat" };
        },
      }),
    ).rejects.toThrow("Repeated records cursor");
    expect(calls).toBe(2);
    calls = 0;
    await expect(
      fetchVisibleGroupedRecords({
        source,
        targetCount: 3,
        signal: new AbortController().signal,
        fetchRecords: async () => {
          calls++;
          return { buckets: [], nextCursor: "repeat" };
        },
      }),
    ).rejects.toThrow("Repeated records cursor");
    expect(calls).toBe(2);
  });

  test("loads large explicit limits in bounded pages and exposes a cursor until the limit is reached", () => {
    expect(queryForRecordsPage({ limit: 2_500 } as RecordQuery, 0).limit).toBe(100);
    expect(queryForRecordsPage({ limit: 2_500 } as RecordQuery, 2_450).limit).toBe(50);
    expect(nextCursorWithinLimit("next", 2_499, 2_500)).toBe("next");
    expect(nextCursorWithinLimit("next", 2_500, 2_500)).toBeNull();
  });
});
