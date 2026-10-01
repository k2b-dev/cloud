import { describe, expect, test } from "bun:test";
import { boardFilter, defaultFilter } from "../filter/types";
import { boardVirtualKinds, kanbanBucketFilter } from "./bucket-filter";

const filter = boardFilter({ ...defaultFilter, assignedTo: "me", deadlineFilter: "week" });
const request = (bucket: Parameters<typeof kanbanBucketFilter>[0]["bucket"], kinds: ("blocked" | "overdue")[]) =>
  kanbanBucketFilter({ bucket, virtualKinds: new Set(kinds), filter, page: 2, pageSize: 30 });
const open = { kind: "column" as const, columnId: "Col001", isDone: false };
const done = { kind: "column" as const, columnId: "Col004", isDone: true };

describe("Kanban bucket requests", () => {
  test("without automatic columns a status column holds all its items", () => {
    const body = request(open, []);
    expect(body).toMatchObject({ status: "active", columnIds: ["Col001"], assignedTo: "me", deadlineFilter: "week", page: 2 });
    expect(body.blocked).toBeUndefined();
    expect(body.overdue).toBeUndefined();
  });

  test("an open status column leaves the tasks of enabled automatic columns to them", () => {
    expect(request(open, ["blocked"])).toMatchObject({ blocked: false, columnIds: ["Col001"] });
    expect(request(open, ["overdue"])).toMatchObject({ overdue: false });
    expect(request(open, ["blocked", "overdue"])).toMatchObject({ blocked: false, overdue: false });
  });

  test("a done column keeps every completed item", () => {
    const body = request(done, ["blocked", "overdue"]);
    expect(body).toMatchObject({ status: "completed", columnIds: ["Col004"] });
    expect(body.blocked).toBeUndefined();
    expect(body.overdue).toBeUndefined();
  });

  test("Blocked gathers open blocked tasks of every status; Overdue leaves them to Blocked", () => {
    const blocked = request({ kind: "blocked", columnId: null, isDone: false }, ["blocked", "overdue"]);
    expect(blocked).toMatchObject({ status: "active", blocked: true, assignedTo: "me" });
    expect(blocked.columnIds).toBeUndefined();
    expect(blocked.overdue).toBeUndefined();

    expect(request({ kind: "overdue", columnId: null, isDone: false }, ["blocked", "overdue"])).toMatchObject({
      status: "active",
      overdue: true,
      blocked: false,
    });
    expect(request({ kind: "overdue", columnId: null, isDone: false }, ["overdue"]).blocked).toBeUndefined();
  });

  test("the board's automatic columns come from its buckets", () => {
    expect([...boardVirtualKinds([{ kind: "column" }, { kind: "overdue" }])]).toEqual(["overdue"]);
  });
});
