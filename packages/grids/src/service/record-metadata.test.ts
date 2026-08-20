import { describe, expect, test } from "bun:test";
import type { RecordMetaQuery } from "../contracts";
import { cleanRecordMeta, recordMetaRequiresDeletedRows } from "./record-metadata";

describe("record metadata query helpers", () => {
  test("drops empty metadata filters", () => {
    expect(cleanRecordMeta(undefined)).toBeUndefined();
    expect(cleanRecordMeta({ users: { createdBy: [], updatedBy: [], deletedBy: [] } })).toBeUndefined();
  });

  test("deduplicates user ids", () => {
    const meta: RecordMetaQuery = {
      ids: ["22222222-2222-4222-8222-222222222222", "22222222-2222-4222-8222-222222222222"],
      users: {
        createdBy: ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"],
      },
    };
    expect(cleanRecordMeta(meta)).toEqual({
      ids: ["22222222-2222-4222-8222-222222222222"],
      users: { createdBy: ["11111111-1111-4111-8111-111111111111"] },
    });
  });

  test("deduplicates Finalization states", () => {
    expect(cleanRecordMeta({ finalizationStates: ["awaitingReview", "awaitingReview", "finalized"] })).toEqual({
      finalizationStates: ["awaitingReview", "finalized"],
    });
  });

  test("deletedBy requires deleted records", () => {
    expect(recordMetaRequiresDeletedRows({ users: { deletedBy: ["11111111-1111-4111-8111-111111111111"] } })).toBe(true);
    expect(recordMetaRequiresDeletedRows({ users: { createdBy: ["11111111-1111-4111-8111-111111111111"] } })).toBe(false);
  });
});
