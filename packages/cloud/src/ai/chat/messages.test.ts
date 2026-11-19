import { expect, test } from "bun:test";
import { actionDetailsMessages } from "./action-details-messages";
import { checkActionMessages } from "./action-messages";
import { checkActionTextMessages } from "./action-text";
import { checkAiChatMessages } from "./messages";

test("AI chat messages contain matching locale contracts", () => {
  expect(checkAiChatMessages()).toEqual([]);
  expect(checkActionMessages()).toEqual([]);
  expect(actionDetailsMessages.check()).toEqual([]);
  expect(checkActionTextMessages()).toEqual([]);
});
