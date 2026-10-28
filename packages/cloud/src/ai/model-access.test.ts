import { describe, expect, test } from "bun:test";
import { AiModelAccessDraftSchema } from "./model-access";

describe("model permission drafts", () => {
  test("accepts model-level grants and rejects public or elevated grants", () => {
    expect(
      AiModelAccessDraftSchema.safeParse({ expectedRevision: 1, entries: [{ principal: { type: "authenticated" }, permission: "read" }] })
        .success,
    ).toBe(true);
    expect(
      AiModelAccessDraftSchema.safeParse({ expectedRevision: 1, entries: [{ principal: { type: "public" }, permission: "read" }] }).success,
    ).toBe(false);
    expect(
      AiModelAccessDraftSchema.parse({
        expectedRevision: 1,
        entries: [{ principal: { type: "authenticated", displayName: "spoof" }, permission: "read" }],
      }).entries[0]?.principal,
    ).toEqual({ type: "authenticated" });
    expect(
      AiModelAccessDraftSchema.safeParse({ expectedRevision: 1, entries: [{ principal: { type: "authenticated" }, permission: "admin" }] })
        .success,
    ).toBe(false);
  });
});
