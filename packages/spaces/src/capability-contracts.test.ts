import { expect, test } from "bun:test";
import { capabilityResultSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import {
  CalendarDestinationListInputSchema,
  CommentCreateInputSchema,
  CommentUpdateInputSchema,
  EventCreateInputSchema,
  EventListItemDataSchema,
  EventUpdateInputSchema,
  ReactionInputSchema,
  SpaceBrowseDataSchema,
  TaskChecklistListDataSchema,
  TaskChecklistUpdateInputSchema,
  TaskCreateInputSchema,
  TaskDependentListInputSchema,
  TaskListInputSchema,
  TaskListItemDataSchema,
  TaskProgressInputSchema,
  TaskSetCompletedInputSchema,
  TaskUpdateInputSchema,
  TemplateCreateInputSchema,
  TemplateUpdateInputSchema,
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

const textInputs = [
  {
    name: "progress note",
    schema: TaskProgressInputSchema,
    input: { itemId: "Itm001" },
    field: "content",
    nullable: false,
    optional: false,
  },
  {
    name: "task create",
    schema: TaskCreateInputSchema,
    input: { spaceId: "Spc001", columnId: "Col001", title: "Task" },
    field: "description",
    nullable: false,
    optional: true,
  },
  {
    name: "task update",
    schema: TaskUpdateInputSchema,
    input: { itemId: "Itm001", title: "Task" },
    field: "description",
    nullable: true,
    optional: true,
  },
  {
    name: "event create",
    schema: EventCreateInputSchema,
    input: { spaceId: "Spc001", columnId: "Col001", title: "Event", startsAt: "2026-10-15T09:00:00Z", endsAt: "2026-10-15T10:00:00Z" },
    field: "description",
    nullable: false,
    optional: true,
  },
  {
    name: "event update",
    schema: EventUpdateInputSchema,
    input: { itemId: "Itm001", title: "Event" },
    field: "description",
    nullable: true,
    optional: true,
  },
  {
    name: "template create",
    schema: TemplateCreateInputSchema,
    input: { spaceId: "Spc001", kind: "task", name: "Template" },
    field: "description",
    nullable: true,
    optional: true,
  },
  {
    name: "template update",
    schema: TemplateUpdateInputSchema,
    input: { templateId: "Tpl001", name: "Template" },
    field: "description",
    nullable: true,
    optional: true,
  },
  {
    name: "comment create",
    schema: CommentCreateInputSchema,
    input: { itemId: "Itm001" },
    field: "content",
    nullable: false,
    optional: false,
  },
  {
    name: "comment update",
    schema: CommentUpdateInputSchema,
    input: { commentId: "Com001" },
    field: "content",
    nullable: false,
    optional: false,
  },
  {
    name: "completion result",
    schema: TaskSetCompletedInputSchema,
    input: { itemId: "Itm001", completed: true },
    field: "result",
    nullable: false,
    optional: true,
  },
];

for (const { name, schema, input, field, nullable, optional } of textInputs) {
  test(`${name} rejects escaped line breaks with actionable guidance`, () => {
    const result = schema.safeParse({ ...input, [field]: "Caption:\\nText" });
    expect(result.success).toBeFalse();
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: [field],
          message: 'Contains "\\n" as two characters; send real line breaks, and put code or paths in backticks.',
        }),
      );
    for (const text of ["Caption:\nText", "Split on `\\n`", "a\\\\nb", "Caption:\\nText\nMore"])
      expect(schema.safeParse({ ...input, [field]: text }).success, text).toBeTrue();
    expect(schema.safeParse({ ...input, [field]: null }).success).toBe(nullable);
    expect(schema.safeParse(input).success).toBe(optional);
  });

  test(`${name} exports a standard JSON Schema text field`, () => {
    const json = z.toJSONSchema(schema, { io: "input" });
    expect(json.properties?.[field]).toMatchObject(
      nullable ? { anyOf: [{ type: "string", maxLength: 5000 }, { type: "null" }] } : { type: "string", maxLength: 5000 },
    );
    expect(z.fromJSONSchema(json).safeParse({ ...input, [field]: "Caption:\\nText" }).success).toBeTrue();
  });
}

test("reaction capability requires one emoji and an item, without recurrence scope", () => {
  for (const emoji of ["👍🏽", "❤️", "👩‍💻", "🇩🇪", "1️⃣"])
    expect(ReactionInputSchema.safeParse({ itemId: "Item01", emoji }).success).toBe(true);
  for (const emoji of ["❤", "ab", "👍👍", "", " "]) expect(ReactionInputSchema.safeParse({ itemId: "Item01", emoji }).success).toBe(false);
  expect(ReactionInputSchema.safeParse({ itemId: "Item01", emoji: "👍", recurrenceId: "2026-10-17T10:00:00Z" }).success).toBe(false);
});
