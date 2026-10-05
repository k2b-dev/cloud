import { describe, expect, test } from "bun:test";
import type { PublicTableQueryResult as TableQueryResult } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";
import {
  highlightedIdsForLiveRefresh,
  liveRefreshQuery,
  shouldLoadNextLiveRefreshPage,
  shouldOptimisticallyRemoveDeletedRecord,
  visibleIdsFromResult,
} from "./live-refresh";

describe("records live refresh helpers", () => {
  test("highlights changed visible rows and newly visible rows", () => {
    expect(
      highlightedIdsForLiveRefresh({
        eventRecordIds: ["b", "x"],
        previousVisibleIds: ["a", "b"],
        nextVisibleIds: ["b", "c"],
      }).sort(),
    ).toEqual(["b", "c"]);
  });

  test("keeps each live refetch page bounded while covering visible rows", () => {
    const query = { filter: undefined } as RecordQuery;
    expect(liveRefreshQuery(query, 140).limit).toBe(140);
    expect(liveRefreshQuery({ ...query, limit: 20 }, 5).limit).toBe(20);
    expect(liveRefreshQuery({ ...query, limit: 1000 }, 700).limit).toBe(500);
  });

  test("continues live refetch pagination only while the visible slice is incomplete", () => {
    expect(shouldLoadNextLiveRefreshPage({ loadedCount: 500, targetCount: 700, nextCursor: "next" })).toBe(true);
    expect(shouldLoadNextLiveRefreshPage({ loadedCount: 700, targetCount: 700, nextCursor: "next" })).toBe(false);
    expect(shouldLoadNextLiveRefreshPage({ loadedCount: 500, targetCount: 700, nextCursor: null })).toBe(false);
  });

  test("extracts visible record ids from query results", () => {
    const result = {
      items: [
        { id: "a", tableId: "t", data: {}, version: 1 },
        { id: "b", tableId: "t", data: {}, version: 1 },
      ],
      nextCursor: null,
    } as TableQueryResult;
    expect(visibleIdsFromResult(result)).toEqual(["a", "b"]);
  });

  test("optimistically removes deletes only from live-only queries", () => {
    expect(shouldOptimisticallyRemoveDeletedRecord({})).toBe(true);
    expect(shouldOptimisticallyRemoveDeletedRecord({ includeDeleted: true })).toBe(false);
    expect(shouldOptimisticallyRemoveDeletedRecord({ deletedOnly: true })).toBe(false);
  });
});
