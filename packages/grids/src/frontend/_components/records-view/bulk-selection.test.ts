import { describe, expect, test } from "bun:test";
import {
  bulkSelectionQuery,
  bulkSelectionRunPayload,
  bulkWorkflowActionLabel,
  bulkWorkflowTargetLabel,
  pruneBulkSelection,
  sameBulkSelection,
} from "./bulk-selection";

describe("records bulk selection helpers", () => {
  test("sends explicit record ids when the user selected rows", () => {
    expect(bulkSelectionRunPayload(["rec-a", "rec-b", "rec-a"], { limit: 50 })).toEqual({
      recordIds: ["rec-a", "rec-b"],
    });
  });

  test("falls back to the current query when no rows are selected", () => {
    const query = {
      limit: 50,
      search: { q: "audio", fieldIds: [] },
      groupBy: [{ field: "Status" }],
      aggregations: [{ function: "count", alias: "records" }],
    } as never;
    expect(bulkSelectionRunPayload([], query)).toEqual({
      query: { limit: 50, search: { q: "audio", fieldIds: [] } },
    });
    expect(bulkSelectionQuery(query)).toEqual({
      limit: 50,
      search: { q: "audio", fieldIds: [] },
    });
  });

  test("forwards deleted-record flags so the server still rejects them", () => {
    // Stripping these client-side would silently retarget the run from the
    // deleted records on screen to the live ones.
    expect(bulkSelectionQuery({ limit: 50, deletedOnly: true } as never)).toEqual({ limit: 50, deletedOnly: true });
    expect(bulkSelectionQuery({ limit: 50, includeDeleted: true } as never)).toEqual({ limit: 50, includeDeleted: true });
  });

  test("prunes selections to the visible loaded records", () => {
    const pruned = pruneBulkSelection(new Set(["rec-a", "rec-b", "rec-c"]), new Set(["rec-b", "rec-c", "rec-d"]));
    expect([...pruned]).toEqual(["rec-b", "rec-c"]);
  });

  test("compares selection sets independent of insertion order", () => {
    expect(sameBulkSelection(new Set(["rec-a", "rec-b"]), new Set(["rec-b", "rec-a"]))).toBe(true);
    expect(sameBulkSelection(new Set(["rec-a"]), new Set(["rec-a", "rec-b"]))).toBe(false);
  });

  test("labels workflow actions by the active run scope", () => {
    expect(bulkWorkflowActionLabel("Print labels", 0)).toBe("Run Print labels for current query");
    expect(bulkWorkflowActionLabel("Print labels", 3)).toBe("Run Print labels for 3 selected");
    expect(bulkWorkflowActionLabel("Close selection", 0, true)).toBe("Select Records to run Close selection");
  });

  test("describes the queued workflow target without reporting zero records", () => {
    expect(bulkWorkflowTargetLabel(0)).toBe("the current result set");
    expect(bulkWorkflowTargetLabel(1)).toBe("1 record");
    expect(bulkWorkflowTargetLabel(3)).toBe("3 records");
  });
});
