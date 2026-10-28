import { describe, expect, test } from "bun:test";
import { checkMailKeptAdminMessages } from "./kept-admin-messages";
import { checkMailPageMessages, mailPageMessages } from "./pages-messages";

describe("Mail SSR messages", () => {
  test("keeps English and German catalogs complete", () => {
    expect(checkMailPageMessages()).toEqual([]);
    expect(checkMailKeptAdminMessages()).toEqual([]);
  });

  test("resolves German regional locales and falls back to English", () => {
    expect(mailPageMessages.resolve(["de-CH"]).t.newMessage).toBe("Neue E-Mail");
    expect(mailPageMessages.resolve(["fr"]).t.newMessage).toBe("New message");
  });
});
