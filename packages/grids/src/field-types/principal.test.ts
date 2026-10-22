import { describe, expect, test } from "bun:test";
import { MAX_PRINCIPALS_PER_FIELD, principalHandler } from "./principal";

const user = { type: "user" as const, id: "11111111-1111-4111-8111-111111111111" };
const account = { type: "service_account" as const, id: "33333333-3333-4333-8333-333333333333" };
const group = { type: "group" as const, id: "22222222-2222-4222-8222-222222222222" };

describe("principal field", () => {
  test("normalizes one or many principals to a deduplicated array", () => {
    expect(principalHandler.validate(user, {}, false)).toEqual({ ok: true, value: [user] });
    expect(principalHandler.validate([user, group, account, user, account], {}, false)).toEqual({
      ok: true,
      value: [user, group, account],
    });
  });

  test("enforces cardinality and required values", () => {
    expect(principalHandler.validate([user, group], { cardinality: "single" }, false)).toEqual({
      ok: false,
      error: "single-cardinality principal accepts at most one value",
    });
    expect(principalHandler.validate([], {}, true)).toEqual({ ok: false, error: "required" });
  });

  test("rejects unsupported principals and oversized values", () => {
    expect(principalHandler.validate([{ type: "public", id: user.id }], {}, false).ok).toBe(false);
    expect(
      principalHandler.validate(
        Array.from({ length: MAX_PRINCIPALS_PER_FIELD + 1 }, () => user),
        {},
        false,
      ).ok,
    ).toBe(false);
  });
});
