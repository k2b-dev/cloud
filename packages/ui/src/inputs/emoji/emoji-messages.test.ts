import { expect, test } from "bun:test";
import { checkEmojiMessages } from "./emoji-messages";

test("keeps every shipped locale of the emoji picker complete", () => {
  expect(checkEmojiMessages()).toEqual([]);
});
