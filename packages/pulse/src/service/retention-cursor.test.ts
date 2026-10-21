import { expect, test } from "bun:test";

const { retentionCursor } = await import("./runtime");

test("a retention job queued before the cursor existed starts from the first base", () => {
  expect(retentionCursor(undefined)).toBeNull();
  expect(retentionCursor({ after: null })).toBeNull();
  expect(retentionCursor({ after: "b1111111-1111-4111-8111-111111111111" })).toBe("b1111111-1111-4111-8111-111111111111");
});
