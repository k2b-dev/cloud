import { expect, test } from "bun:test";
import { TaskUpdateInputSchema } from "./capability-contracts";
import { CreateItemSchema, UpdateItemSchema } from "./contracts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

test("assignment deltas cannot silently mix replacement and incremental intent", () => {
  expect(UpdateItemSchema.parse({ addAssigneeIds: [first], removeAssigneeIds: [second] })).toEqual({
    addAssigneeIds: [first],
    removeAssigneeIds: [second],
  });
  expect(UpdateItemSchema.safeParse({ assigneeIds: [], addAssigneeIds: [first] }).success).toBeFalse();
  expect(UpdateItemSchema.safeParse({ addAssigneeIds: [first], removeAssigneeIds: [first] }).success).toBeFalse();
});

test("a title approval carries the exact previous title", () => {
  const input = { itemId: "Item01", title: "Next" };
  expect(TaskUpdateInputSchema.safeParse(input).success).toBeFalse();
  expect(TaskUpdateInputSchema.parse({ ...input, expectedTitle: "  Original  " }).expectedTitle).toBe("  Original  ");
  expect(UpdateItemSchema.parse({ title: "Next", expectedTitle: "Original" }).expectedTitle).toBe("Original");
});

test("create keys have a bounded, nonempty public contract", () => {
  const input = { columnId: "Column", title: "New task" };
  expect(CreateItemSchema.parse({ ...input, requestKey: " retry-1 " }).requestKey).toBe("retry-1");
  expect(CreateItemSchema.safeParse({ ...input, requestKey: " " }).success).toBeFalse();
  expect(CreateItemSchema.safeParse({ ...input, requestKey: "k".repeat(201) }).success).toBeFalse();
});
