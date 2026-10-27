import { describe, expect, test } from "bun:test";
import { AiModelAccessDraftSchema } from "./model-access";

describe("model permission drafts", () => {
  test("accepts model-level grants and rejects public or elevated grants", () => {
    expect(
      AiModelAccessDraftSchema.safeParse({ expectedRevision: 1, entries: [{ principal: { type: "authenticated" }, permission: "read" }] })
        .success,
    ).toBe(true);
    for (const principal of [{ type: "public" }, { type: "authenticated", displayName: "spoof" }])
      expect(AiModelAccessDraftSchema.safeParse({ expectedRevision: 1, entries: [{ principal, permission: "read" }] }).success).toBe(false);
    expect(
      AiModelAccessDraftSchema.safeParse({ expectedRevision: 1, entries: [{ principal: { type: "authenticated" }, permission: "admin" }] })
        .success,
    ).toBe(false);
  });
});
