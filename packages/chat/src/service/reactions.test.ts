import { expect, test } from "bun:test";
import { ChatLiveEventSchema, EmojiSchema } from "./contracts";

for (const emoji of [
  "😀",
  "👍🏽",
  "👨‍👩‍👧‍👦",
  "🏳️‍🌈",
  "🇩🇪",
  "🇺🇳",
  "1️⃣",
  "#⃣",
  "*️⃣",
  "❤️",
  "❤",
  "🧑🏿‍🚀",
  "©️",
  "↔️",
  "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
])
  test(`accepts one emoji grapheme: ${emoji}`, () => expect(EmojiSchema.safeParse(emoji).success).toBeTrue());
for (const emoji of [
  "",
  "x",
  "hello😀",
  "😀😀",
  "😀 ",
  " 🇩🇪",
  "🇩",
  "🏽",
  "1",
  "#",
  "1️",
  "😀‍",
  "😀́",
  "😀\u0000",
  "👨🏿‍👩🏿‍👧🏿‍👦🏿",
  "\ud800",
  "😀\ufe0e",
  "😀🏽",
])
  test(`rejects non-emoji, multiple graphemes or over-budget emoji: ${JSON.stringify(emoji)}`, () =>
    expect(EmojiSchema.safeParse(emoji).success).toBeFalse());

test("reaction live hints contain only identity and revision", () => {
  const hint = { type: "reactions" as const, conversationId: "abcdef", messageId: "0123456789", rev: 2 };
  expect(ChatLiveEventSchema.parse(hint)).toEqual(hint);
  for (const extra of [{ own: true }, { people: ["Lea"] }, { systemText: "Reacted" }])
    expect(ChatLiveEventSchema.safeParse({ ...hint, ...extra }).success).toBeFalse();
});
