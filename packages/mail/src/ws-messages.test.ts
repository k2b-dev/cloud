import { describe, expect, test } from "bun:test";
import { checkMailWsMessages, mailWsMessages } from "./ws-messages";

describe("Mail WebSocket messages", () => {
  test("resolves concurrent connection locales independently", async () => {
    expect(checkMailWsMessages()).toEqual([]);
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => mailWsMessages("en").streamFailed),
      Promise.resolve().then(() => mailWsMessages("de-CH").streamFailed),
    ]);
    expect(english).toBe("Mail event stream failed");
    expect(german).toBe("Der Mail-Ereignisstrom ist fehlgeschlagen");
  });
});
