import { expect, test } from "bun:test";
import { chatCommandQuery, reconcileChatMentions } from "./composer-document";

test("slash uses the caret anywhere and rejects paths, URLs and code", () => {
  expect(chatCommandQuery("Use /sk then continue", 7)).toEqual({ start: 4, end: 7, query: "sk" });
  expect(chatCommandQuery("First\n/app invoice", 18)?.query).toBe("app invoice");
  for (const text of ["https://host", "/usr/local", "`/skill", "```\n/skill"]) expect(chatCommandQuery(text, text.length)).toBeNull();
  expect(chatCommandQuery("/skill", 6, 2)).toBeNull();
});

test("edits before and after mentions preserve identity; edits inside remove it", () => {
  const mentions = [{ start: 4, end: 9, attachment: { id: "skill:1", name: "Skill" } }];
  expect(reconcileChatMentions("Use Skill now", "Please use Skill now", mentions)[0]?.start).toBe(11);
  expect(reconcileChatMentions("Use Skill now", "Use Skill tomorrow", mentions)).toEqual(mentions);
  expect(reconcileChatMentions("Use Skill now", "Use Still now", mentions)).toEqual([]);
  expect(reconcileChatMentions("Use Skill now", "Use now", mentions)).toEqual([]);
});
