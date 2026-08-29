import { describe, expect, test } from "bun:test";
import { customAppMessagesFor } from "./custom-app-messages";
import { saveDraft } from "./custom-apps";

describe("Custom App service messages", () => {
  test("uses German for regional German locales", async () => {
    const messages = customAppMessagesFor("de-CH");
    const invalidDraft = await saveDraft("unused", {}, "de-CH");

    expect(messages.home).toBe("Start");
    expect(invalidDraft.ok).toBe(false);
    if (!invalidDraft.ok) expect(invalidDraft.error.message).toBe("Die Definition der Grids-App ist ungültig.");
  });

  test("falls back to English for unsupported locales", () => {
    expect(customAppMessagesFor("fr").home).toBe("Home");
  });
});
