import { describe, expect, test } from "bun:test";
import { chatMessages, checkChatMessages } from "./chat-messages";
import { type ReactionPeopleInput, reactionPeople } from "./reaction-people";

const nora = "Nora Brandt";
const cases: { input: ReactionPeopleInput; en: string; de: string }[] = [
  { input: { names: [nora], count: 1 }, en: nora, de: nora },
  { input: { names: [nora], own: true, count: 2 }, en: "You and Nora Brandt", de: "Du und Nora Brandt" },
  {
    input: { names: [nora, "Release-Bot"], own: true, count: 3 },
    en: "You, Nora Brandt and Release-Bot",
    de: "Du, Nora Brandt und Release-Bot",
  },
  {
    input: { names: [nora, "Tobias Wendt", "Lea Sommer", "Jonas Peters", "Mara Feld"], count: 5 },
    en: "Nora Brandt, Tobias Wendt and 3 more",
    de: "Nora Brandt, Tobias Wendt und 3 weitere",
  },
  {
    input: { names: [nora, "Tobias Wendt", "Lea Sommer", "Jonas Peters"], own: true, count: 5 },
    en: "You, Nora Brandt and 3 more",
    de: "Du, Nora Brandt und 3 weitere",
  },
  { input: { names: ["Nora"], count: 3 }, en: "Nora and 2 more", de: "Nora und 2 weitere" },
  { input: { names: ["Nora", "Tobias"], own: true, count: 1 }, en: "You, Nora and Tobias", de: "Du, Nora und Tobias" },
  { input: { names: [], own: true, count: 1 }, en: "You", de: "Du" },
  { input: { names: [], count: 0 }, en: "", de: "" },
  { input: { names: [], count: 4 }, en: "and 4 more", de: "und 4 weitere" },
];

describe("reactionPeople", () => {
  for (const locale of ["en", "de"] as const) {
    for (const { input, ...expected } of cases) {
      test(`${locale}: ${expected[locale] || "no people"}`, () => expect(reactionPeople(input, locale)).toBe(expected[locale]));
    }
  }
  test("defaults to English and resolves regional locales", () => {
    expect(reactionPeople({ names: [nora], own: true, count: 2 })).toBe("You and Nora Brandt");
    expect(reactionPeople({ names: [nora], own: true, count: 2 }, "de-DE")).toBe("Du und Nora Brandt");
  });
  test("keeps reaction messages complete in every locale", () => {
    expect(checkChatMessages()).toEqual([]);
    for (const locale of ["en", "de"]) {
      const t = chatMessages.resolve([locale]).t;
      expect(t.reactionYou).toBeTruthy();
      expect(t.reactionAnd).toBeTruthy();
      expect(t.reactionMorePeople({ count: 2 })).toBe(locale === "en" ? "and 2 more" : "und 2 weitere");
      expect(t.moreReactions({ count: 1 })).toBe(locale === "en" ? "1 more reaction" : "1 weitere Reaktion");
      expect(t.moreReactions({ count: 2 })).toBe(locale === "en" ? "2 more reactions" : "2 weitere Reaktionen");
    }
  });
});
