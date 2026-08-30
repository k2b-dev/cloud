import { describe, expect, test } from "bun:test";
import { aiLiveMessages, checkAiLiveMessages } from "./live-messages";

describe("AI live messages", () => {
  test("resolves concurrent connection locales independently", async () => {
    expect(checkAiLiveMessages()).toEqual([]);
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => aiLiveMessages("en").subscriptionFailed),
      Promise.resolve().then(() => aiLiveMessages("de-CH").subscriptionFailed),
    ]);
    expect(english).toBe("AI live subscription failed");
    expect(german).toBe("Die Anmeldung für AI Live ist fehlgeschlagen");
  });
});
