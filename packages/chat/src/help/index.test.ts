import { describe, expect, test } from "bun:test";
import { chatHelp } from ".";

describe("chatHelp", () => {
  test("ships matching English and German documents", () => {
    const english = chatHelp.documentsByLocale?.en ?? [];
    const german = chatHelp.documentsByLocale?.de ?? [];
    expect(english.map((document) => document.id)).toEqual(["chat-start"]);
    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    expect(chatHelp.getMarkdown("chat-start")).toContain("conversations with other people");
    expect(chatHelp.getMarkdown("chat-start", "de-AT")).toContain("Gespräche mit anderen Personen");
  });
});
