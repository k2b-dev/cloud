import { describe, expect, spyOn, test } from "bun:test";
import type { sql } from "bun";
import { getAiCredential } from "./credentials";

describe("getAiCredential", () => {
  test("treats an unreadable encrypted value as a missing credential", async () => {
    const db = (() => Promise.resolve([{ secret: "not-an-encrypted-value" }])) as unknown as typeof sql;
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(await getAiCredential("broken", db)).toBeNull();
    } finally {
      warning.mockRestore();
    }
  });

  test("does not disguise database failures as missing credentials", async () => {
    const db = (() => Promise.reject(new Error("database unavailable"))) as unknown as typeof sql;

    await expect(getAiCredential("model", db)).rejects.toThrow("database unavailable");
  });
});
