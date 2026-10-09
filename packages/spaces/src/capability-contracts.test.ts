import { expect, test } from "bun:test";
import { capabilityResultSchema } from "@k2b/cloud/contracts";
import {
  CalendarDestinationListInputSchema,
  EventListItemDataSchema,
  SpaceBrowseDataSchema,
  TaskChecklistListDataSchema,
  TaskChecklistUpdateInputSchema,
  TaskDependentListInputSchema,
  TaskListInputSchema,
  TaskListItemDataSchema,
} from "./capability-contracts";

test("existing Space list inputs retain defaults with additive work filters", () => {
  const input = TaskListInputSchema.parse({ spaceId: "Spc001" });
  expect(input.activity).toBe("all");
  expect(input.deadlineFilter).toBe("all");
  expect(input.limit).toBe(25);
  expect(CalendarDestinationListInputSchema.parse({})).toEqual({ limit: 100 });
});

test("task and event lists require a nonnegative integer assignee total", () => {
  for (const schema of [TaskListItemDataSchema, EventListItemDataSchema]) {
    const count = schema.shape.assigneeCount;
    expect(count.parse(0)).toBe(0);
    expect(count.parse(11)).toBe(11);
    for (const invalid of [undefined, -1, 1.5]) expect(count.safeParse(invalid).success).toBeFalse();
  }
});

test("task lists require an overdue boolean without extending event lists", () => {
  const overdue = TaskListItemDataSchema.shape.overdue;
  expect(overdue.parse(true)).toBeTrue();
  expect(overdue.parse(false)).toBeFalse();
  for (const invalid of [undefined, null, "false", 0]) expect(overdue.safeParse(invalid).success).toBeFalse();
  expect("overdue" in EventListItemDataSchema.shape).toBeFalse();
});

test("reverse dependency pages default to the existing 100-entry result limit", () => {
  expect(TaskDependentListInputSchema.parse({ itemId: "Itm001" })).toEqual({ itemId: "Itm001", limit: 100 });
  expect(TaskDependentListInputSchema.safeParse({ itemId: "Itm001", limit: 101 }).success).toBeFalse();
});

test("compact selection and complete checklist fit the result envelope", () => {
  const entry = { id: "Spc001", ref: { type: "spaces.space", id: "Spc001" }, name: "Product", description: null, permission: "write" };
  expect(capabilityResultSchema(SpaceBrowseDataSchema).safeParse({ data: [entry], page: { hasMore: false } }).success).toBeTrue();
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `Chk${String(index).padStart(3, "0")}`,
    label: "Check",
    completed: false,
  }));
  expect(
    capabilityResultSchema(TaskChecklistListDataSchema).safeParse({ data: entries, refs: [{ type: "spaces.item", id: "Itm001" }] }).success,
  ).toBeTrue();
});

test("checklist patch requires an actual field, including explicit false", () => {
  expect(TaskChecklistUpdateInputSchema.safeParse({ itemId: "Itm001", entryId: "Chk001" }).success).toBeFalse();
  expect(TaskChecklistUpdateInputSchema.parse({ itemId: "Itm001", entryId: "Chk001", completed: false }).completed).toBeFalse();
});
