import { describe, expect, test } from "bun:test";
import { newShortId, SHORT_ID_REGEX, withShortIdRetry } from "./short-id";

describe("Spaces short IDs", () => {
  test("generates compact readable identifiers", () => {
    const ids = Array.from({ length: 100 }, newShortId);
    expect(ids.every((id) => SHORT_ID_REGEX.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("retries only the matching short-ID unique constraint", async () => {
    let attempts = 0;
    const value = await withShortIdRetry(["item"], async () => {
      attempts++;
      if (attempts === 1) throw { errno: "23505", constraint: "idx_items_short_id" };
      return "created";
    });
    expect(value).toBe("created");
    expect(attempts).toBe(2);

    let postgresJsAttempts = 0;
    await withShortIdRetry(["item"], async () => {
      postgresJsAttempts++;
      if (postgresJsAttempts === 1) throw { code: "23505", constraint_name: "idx_items_short_id" };
    });
    expect(postgresJsAttempts).toBe(2);

    let attachmentAttempts = 0;
    await withShortIdRetry(["attachment"], async () => {
      attachmentAttempts++;
      if (attachmentAttempts === 1) throw { code: "23505", constraint: "idx_item_attachments_short_id" };
    });
    expect(attachmentAttempts).toBe(2);

    await expect(
      withShortIdRetry(["item"], async () => {
        throw { code: "23505", constraint: "items_pkey" };
      }),
    ).rejects.toEqual({ code: "23505", constraint: "items_pkey" });
  });
});
