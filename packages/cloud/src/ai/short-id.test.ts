import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { AI_SHORT_ID_PATTERN, createAiShortId, withAiShortIdForDb } from "./short-id";

describe("AI short IDs", () => {
  test("creates compact readable identifiers", () => {
    const ids = Array.from({ length: 100 }, createAiShortId);

    expect(ids.every((id) => AI_SHORT_ID_PATTERN.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.join("")).not.toMatch(/[01IOlo]/);
  });

  test("isolates a collision retry in a transaction savepoint", async () => {
    const attempts: string[] = [];
    const db = {
      savepoint: async <T>(run: (attempt: SQL) => Promise<T>) => run({} as SQL),
    } as SQL & { savepoint: <T>(run: (attempt: SQL) => Promise<T>) => Promise<T> };
    const ids = ["AAAAAA", "BBBBBB"];
    const result = await withAiShortIdForDb(
      db,
      "short_id_unique",
      async (_attempt, shortId) => {
        attempts.push(shortId);
        if (shortId === "AAAAAA") throw { code: "ERR_POSTGRES_SERVER_ERROR", errno: "23505", constraint: "short_id_unique" };
        return shortId;
      },
      () => ids.shift()!,
    );
    expect(result).toBe("BBBBBB");
    expect(attempts).toEqual(["AAAAAA", "BBBBBB"]);
  });
});
