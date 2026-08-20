import { describe, expect, test } from "bun:test";
import {
  CalendarQuerySchema,
  CreateItemSchema,
  CreateSpaceSchema,
  CreateWormholeSchema,
  ItemFilterSchema,
  MAX_TASK_ATTACHMENT_SIZE_BYTES,
  OverlapQuerySchema,
  ReorderColumnsSchema,
  ReorderWormholesSchema,
  SpaceItemAttachmentSchema,
  UpdateItemSchema,
  UpdateWormholeSchema,
} from "./contracts";

const START = "2026-06-01T09:00:00.000Z";
const END = "2026-06-01T10:00:00.000Z";
const BEFORE_START = "2026-06-01T08:00:00.000Z";
const columnId = "Col001";
const wormholeId = "Whl001";

describe("Spaces contract time ranges", () => {
  test("accepts valid create, update, calendar, and overlap ranges", () => {
    expect(CreateItemSchema.safeParse({ columnId, title: "Event", startsAt: START, endsAt: END }).success).toBe(true);
    expect(UpdateItemSchema.safeParse({ startsAt: START, endsAt: END }).success).toBe(true);
    expect(CalendarQuerySchema.safeParse({ from: START, to: END }).success).toBe(true);
    expect(OverlapQuerySchema.safeParse({ from: START, to: END }).success).toBe(true);
  });

  test("rejects ranges whose end is not after the start", () => {
    expect(CreateItemSchema.safeParse({ columnId, title: "Event", startsAt: START, endsAt: BEFORE_START }).success).toBe(false);
    expect(UpdateItemSchema.safeParse({ startsAt: START, endsAt: BEFORE_START }).success).toBe(false);
    expect(CalendarQuerySchema.safeParse({ from: START, to: BEFORE_START }).success).toBe(false);
    expect(OverlapQuerySchema.safeParse({ from: START, to: BEFORE_START }).success).toBe(false);
  });
});

describe("Spaces task estimates", () => {
  test("accepts positive whole-minute estimates for tasks", () => {
    expect(CreateItemSchema.parse({ columnId, title: "Plan", estimatedDurationMinutes: 90 }).estimatedDurationMinutes).toBe(90);
    expect(UpdateItemSchema.safeParse({ estimatedDurationMinutes: null }).success).toBe(true);
  });

  test("rejects invalid estimates and event estimates", () => {
    expect(CreateItemSchema.safeParse({ columnId, title: "Plan", estimatedDurationMinutes: 0 }).success).toBe(false);
    expect(CreateItemSchema.safeParse({ columnId, title: "Plan", estimatedDurationMinutes: 1.5 }).success).toBe(false);
    expect(
      CreateItemSchema.safeParse({
        columnId,
        title: "Meeting",
        startsAt: START,
        endsAt: END,
        estimatedDurationMinutes: 30,
      }).success,
    ).toBe(false);
  });
});

describe("Spaces task attachment contracts", () => {
  test("accepts bounded public attachment metadata", () => {
    expect(
      SpaceItemAttachmentSchema.safeParse({
        id: "File01",
        filename: "broken-dialog.webp",
        mimeType: "image/webp",
        sizeBytes: MAX_TASK_ATTACHMENT_SIZE_BYTES,
        kind: "image",
        createdAt: START,
      }).success,
    ).toBe(true);
  });

  test("rejects legacy IDs and oversized metadata", () => {
    const attachment = {
      id: "File01",
      filename: "trace.txt",
      mimeType: "text/plain",
      sizeBytes: MAX_TASK_ATTACHMENT_SIZE_BYTES + 1,
      kind: "file",
      createdAt: START,
    };
    expect(SpaceItemAttachmentSchema.safeParse(attachment).success).toBe(false);
    expect(SpaceItemAttachmentSchema.safeParse({ ...attachment, id: crypto.randomUUID(), sizeBytes: 1 }).success).toBe(false);
  });
});

describe("Spaces starter contracts", () => {
  test("keeps starter selection optional and accepts the supported workflows", () => {
    expect(CreateSpaceSchema.safeParse({ name: "Legacy client" }).success).toBe(true);
    for (const starter of ["blank", "tasks", "calendar", "project"]) {
      expect(CreateSpaceSchema.safeParse({ name: "Team space", starter }).success).toBe(true);
    }
  });

  test("rejects unknown starter identifiers", () => {
    expect(CreateSpaceSchema.safeParse({ name: "Team space", starter: "crm" }).success).toBe(false);
  });
});

test("Spaces item filters default the overview to schedule grouping", () => {
  expect(ItemFilterSchema.parse({}).groupBy).toBe("deadline");
});

describe("Spaces wormhole contracts", () => {
  test("accepts typed create, update, and reorder payloads", () => {
    expect(CreateWormholeSchema.safeParse({ targetColumnId: columnId, color: "#6366f1" }).success).toBe(true);
    expect(UpdateWormholeSchema.safeParse({ color: "#10b981" }).success).toBe(true);
    expect(ReorderWormholesSchema.safeParse({ wormholeIds: [wormholeId] }).success).toBe(true);
  });

  test("rejects empty updates and invalid colors", () => {
    expect(UpdateWormholeSchema.safeParse({}).success).toBe(false);
    expect(CreateWormholeSchema.safeParse({ targetColumnId: columnId, color: "indigo" }).success).toBe(false);
  });

  test("rejects legacy UUID resource identifiers", () => {
    expect(CreateWormholeSchema.safeParse({ targetColumnId: crypto.randomUUID(), color: "#6366f1" }).success).toBe(false);
    expect(CreateItemSchema.safeParse({ columnId: crypto.randomUUID(), title: "Legacy" }).success).toBe(false);
  });

  test("bounds public reorder requests", () => {
    expect(ReorderColumnsSchema.safeParse({ columnIds: Array.from({ length: 101 }, () => columnId) }).success).toBe(false);
    expect(ReorderWormholesSchema.safeParse({ wormholeIds: Array.from({ length: 101 }, () => wormholeId) }).success).toBe(false);
  });
});
