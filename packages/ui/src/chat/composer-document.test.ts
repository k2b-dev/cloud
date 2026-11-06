import { describe, expect, test } from "bun:test";
import { chatCommandQuery, chatPeopleQuery, reconcileChatMentions } from "./composer-document";

test("slash uses the caret anywhere and rejects paths, URLs and code", () => {
  expect(chatCommandQuery("Use /sk then continue", 7)).toEqual({ start: 4, end: 7, query: "sk" });
  expect(chatCommandQuery("First\n/app invoice", 18)?.query).toBe("app invoice");
  for (const text of ["50 / 2", "/ ", "/\tword", "https://host", "/usr/local", "`/skill", "```\n/skill"])
    expect(chatCommandQuery(text, text.length)).toBeNull();
  expect(chatCommandQuery("/skill", 6, 2)).toBeNull();
});

test("edits before and after mentions preserve identity; edits inside remove it", () => {
  const mentions = [{ start: 4, end: 9, attachment: { id: "skill:1", name: "Skill" } }];
  expect(reconcileChatMentions("Use Skill now", "Please use Skill now", mentions)[0]?.start).toBe(11);
  expect(reconcileChatMentions("Use Skill now", "Use Skill tomorrow", mentions)).toEqual(mentions);
  expect(reconcileChatMentions("Use Skill now", "Use Still now", mentions)).toEqual([]);
  expect(reconcileChatMentions("Use Skill now", "Use now", mentions)).toEqual([]);
});

describe("chatPeopleQuery", () => {
  test("finds @name at the caret after the start, a space or a parenthesis", () => {
    expect(chatPeopleQuery("@Mar", 4)).toEqual({ start: 0, end: 4, query: "Mar" });
    expect(chatPeopleQuery("Hallo @", 7)).toEqual({ start: 6, end: 7, query: "" });
    expect(chatPeopleQuery("(@le", 4)).toEqual({ start: 1, end: 4, query: "le" });
  });

  test("ignores mail addresses, selections, code, finished words and existing mentions", () => {
    expect(chatPeopleQuery("mara@example", 12)).toBeNull();
    expect(chatPeopleQuery("@Mar", 1, 4)).toBeNull();
    expect(chatPeopleQuery("`@Mar", 5)).toBeNull();
    expect(chatPeopleQuery("@Mara ", 6)).toBeNull();
    const mention = { start: 0, end: 5, attachment: { id: "1", name: "@Mara" } };
    expect(chatPeopleQuery("@Mara", 5, 5, [mention])).toBeNull();
  });
});
