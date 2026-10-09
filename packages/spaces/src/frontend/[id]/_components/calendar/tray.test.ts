import { describe, expect, test } from "bun:test";
import { defaultCalendarFilter } from "./filter";
import { taskTrayFiltered, taskTrayFilters, taskTrayListHref } from "./tray";

describe("Spaces task tray queries", () => {
  test("ask for open tasks under the calendar's filter: overdue ones, and undated ones of the reader", () => {
    const queries = taskTrayFilters({ ...defaultCalendarFilter, assignedTo: "assigned", priorities: ["high"], columnIds: ["Col001"] });
    expect(queries?.overdue).toMatchObject({
      type: "task",
      status: "active",
      assignedTo: "assigned",
      deadlineFilter: "overdue",
      priority: ["high"],
      columnIds: ["Col001"],
      sort: "deadline",
      sortDesc: true,
    });
    expect(queries?.undated).toMatchObject({ type: "task", status: "active", assignedTo: "me", deadlineFilter: "none", sort: "priority" });
  });

  test("rule out what the filter excludes", () => {
    expect(taskTrayFilters({ ...defaultCalendarFilter, type: "event" })).toBeNull();
    expect(taskTrayFilters({ ...defaultCalendarFilter, assignedTo: "unassigned" })?.undated).toBeNull();
  });

  test("count as filtered where the filter leaves out tasks the tray would show", () => {
    expect(taskTrayFiltered(defaultCalendarFilter)).toBe(false);
    expect(taskTrayFiltered({ ...defaultCalendarFilter, type: "task", colorBy: "person" })).toBe(false);
    for (const narrowed of [
      { assignedTo: "me" as const },
      { assignedTo: "unassigned" as const },
      { priorities: ["high" as const] },
      { columnIds: ["Col001"] },
      { tagIds: ["Tag001"] },
    ]) {
      expect(taskTrayFiltered({ ...defaultCalendarFilter, ...narrowed })).toBe(true);
    }
  });

  test("link each part to the list view with the same query", () => {
    const undated = taskTrayFilters(defaultCalendarFilter)?.undated;
    expect(undated && taskTrayListHref("/app/spaces/Space1", undated)).toBe(
      "/app/spaces/Space1?view=list&type=task&assignedTo=me&deadline=none&sort=priority",
    );
  });
});
