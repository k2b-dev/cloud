import { expect, test } from "bun:test";
import { capabilityResultSchema } from "@k2b/cloud/contracts";
import {
  CalendarDestinationListInputSchema,
  SpaceBrowseDataSchema,
  TaskChecklistListDataSchema,
  TaskChecklistUpdateInputSchema,
  TaskListInputSchema,
} from "./capability-contracts";

test("existing Space list inputs retain defaults with additive work filters", () => {
  const input = TaskListInputSchema.parse({ spaceId: "Spc001" });
  expect(input.activity).toBe("all");
  expect(input.deadlineFilter).toBe("all");
  expect(input.limit).toBe(25);
  expect(CalendarDestinationListInputSchema.parse({})).toEqual({ limit: 100 });
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
