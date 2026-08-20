import { describe, expect, test } from "bun:test";
import { cleanRecordMetaQuery, recordMetaActiveCount } from "./RecordMetadataDialog";

describe("Record metadata Finalization filter", () => {
  test("keeps one current state beside actor filters", () => {
    const meta = {
      finalizationStates: ["awaitingReview" as const],
      users: { updatedBy: ["11111111-1111-4111-8111-111111111111"] },
    };
    expect(cleanRecordMetaQuery(meta)).toEqual(meta);
    expect(recordMetaActiveCount(meta)).toBe(2);
  });

  test("drops an empty state selection", () => {
    expect(cleanRecordMetaQuery({ finalizationStates: [] })).toBeUndefined();
  });
});
