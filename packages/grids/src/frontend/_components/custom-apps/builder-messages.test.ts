import { describe, expect, test } from "bun:test";
import { customAppBuilderMessages } from "./builder-messages";

describe("custom App builder messages", () => {
  test("uses German for regional German locales", () => {
    const messages = customAppBuilderMessages.resolve(["de-CH"]).t;

    expect(messages.text({ value: "Actions" })).toBe("Aktionen");
    expect(messages.pageNumber({ number: 2 })).toBe("Seite 2");
  });

  test("falls back to English for unsupported locales", () => {
    const messages = customAppBuilderMessages.resolve(["fr"]).t;

    expect(messages.text({ value: "Actions" })).toBe("Actions");
    expect(messages.pageNumber({ number: 2 })).toBe("Page 2");
  });
});
