import { describe, expect, test } from "bun:test";
import {
  attachmentMediaType,
  CalendarQuerySchema,
  CreateItemSchema,
  CreateSpaceSchema,
  CreateTaskChecklistEntrySchema,
  CreateWormholeSchema,
  ItemFilterSchema,
  isPlayableVideoType,
  MAX_TASK_ATTACHMENT_SIZE_BYTES,
  MoveItemSchema,
  OverlapQuerySchema,
  ReorderColumnsSchema,
  ReorderWormholesSchema,
  SpaceItemAttachmentSchema,
  UpdateItemSchema,
  UpdateTaskChecklistEntrySchema,
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

describe("Spaces item move contract", () => {
  test("accepts one neighbor anchor, a legacy rank, both together, or no position", () => {
    expect(MoveItemSchema.safeParse({ columnId, afterItemId: "Item01" }).success).toBe(true);
    expect(MoveItemSchema.safeParse({ columnId, beforeItemId: "Item01" }).success).toBe(true);
    expect(MoveItemSchema.safeParse({ columnId, rank: "-2048" }).success).toBe(true);
    expect(MoveItemSchema.safeParse({ columnId, afterItemId: "Item01", rank: "2048" }).success).toBe(true);
    expect(MoveItemSchema.safeParse({ columnId }).success).toBe(true);
  });

  test("rejects two anchors, malformed anchors, and non-integer ranks", () => {
    expect(MoveItemSchema.safeParse({ columnId, afterItemId: "Item01", beforeItemId: "Item02" }).success).toBe(false);
    expect(MoveItemSchema.safeParse({ columnId, afterItemId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(MoveItemSchema.safeParse({ columnId, rank: "1.5" }).success).toBe(false);
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
  expect(ItemFilterSchema.parse({}).activity).toBe("all");
  expect(ItemFilterSchema.parse({ activity: "inactive" }).activity).toBe("inactive");
});

describe("Spaces task checklist contracts", () => {
  test("accepts only a bounded label plus completion changes", () => {
    expect(CreateTaskChecklistEntrySchema.parse({ label: "  Review copy  " }).label).toBe("Review copy");
    expect(CreateTaskChecklistEntrySchema.parse({ label: "Review", completed: true }).completed).toBe(true);
    expect(UpdateTaskChecklistEntrySchema.safeParse({ completed: true }).success).toBe(true);
    expect(UpdateTaskChecklistEntrySchema.safeParse({ label: "Rename" }).success).toBe(true);
  });

  test("rejects empty labels, empty updates, and task-like fields", () => {
    expect(CreateTaskChecklistEntrySchema.safeParse({ label: " " }).success).toBe(false);
    expect(UpdateTaskChecklistEntrySchema.safeParse({}).success).toBe(false);
    expect(CreateTaskChecklistEntrySchema.safeParse({ label: "Review", deadline: START }).success).toBe(false);
  });
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
    // 100 columns plus both automatic columns, named by kind.
    const fullBoard = [...Array.from({ length: 100 }, () => columnId), "blocked", "overdue"];
    expect(ReorderColumnsSchema.safeParse({ columnIds: fullBoard }).success).toBe(true);
    expect(ReorderColumnsSchema.safeParse({ columnIds: [...fullBoard, columnId] }).success).toBe(false);
    expect(ReorderColumnsSchema.safeParse({ columnIds: ["stalled"] }).success).toBe(false);
    expect(ReorderWormholesSchema.safeParse({ wormholeIds: Array.from({ length: 101 }, () => wormholeId) }).success).toBe(false);
  });
});

describe("attachment media types", () => {
  test("a video without a declared type gets the type of its extension", () => {
    expect(attachmentMediaType("Reel.MOV", "")).toBe("video/quicktime");
    expect(attachmentMediaType("Reel.m4v", "application/octet-stream")).toBe("video/x-m4v");
    expect(attachmentMediaType("Reel.webm", "video/webm")).toBe("video/webm");
    expect(attachmentMediaType("notes.pdf", "application/pdf")).toBe("application/pdf");
    expect(isPlayableVideoType("video/mp4; codecs=avc1")).toBe(true);
    expect(isPlayableVideoType("video/x-matroska")).toBe(false);
  });

  test("an extension named like an object member stays an unknown file", () => {
    for (const extension of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(attachmentMediaType(`notes.${extension}`, "application/octet-stream")).toBe("application/octet-stream");
      expect(attachmentMediaType(`notes.${extension}`, "")).toBe("application/octet-stream");
    }
  });
});
