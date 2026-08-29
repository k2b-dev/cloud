import { expect, test } from "bun:test";
import { checkAiChatMessages } from "./messages";

test("AI chat messages contain matching locale contracts", () => {
  expect(checkAiChatMessages()).toEqual([]);
});
