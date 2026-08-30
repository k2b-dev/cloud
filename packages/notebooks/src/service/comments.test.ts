import { describe, expect, test } from "bun:test";
import { canMutateComment, COMMENT_MUTATION_WINDOW_MS } from "./comments";

const authorUserId = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-08-30T12:00:00.000Z");

describe("note comment mutation window", () => {
  test("allows only the author during the first ten minutes", () => {
    const comment = { authorUserId, createdAt: new Date(now - COMMENT_MUTATION_WINDOW_MS) };

    expect(canMutateComment(comment, authorUserId, now)).toBeTrue();
    expect(canMutateComment(comment, "22222222-2222-4222-8222-222222222222", now)).toBeFalse();
    expect(canMutateComment(comment, null, now)).toBeFalse();
  });

  test("closes after ten minutes", () => {
    const comment = { authorUserId, createdAt: new Date(now - COMMENT_MUTATION_WINDOW_MS - 1) };

    expect(canMutateComment(comment, authorUserId, now)).toBeFalse();
  });
});
