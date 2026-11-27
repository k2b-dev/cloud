import { expect, test } from "bun:test";
import { AI_SIDEBAR_CONVERSATIONS_MAX } from "@k2b/cloud/ai";
import { sidebarPage } from "./sidebar";

test("the sidebar shows at most the bound of open chats and says when more exist", () => {
  const chats = (count: number) => Array.from({ length: count }, (_, index) => `chat-${index}`);
  expect(sidebarPage(chats(AI_SIDEBAR_CONVERSATIONS_MAX))).toEqual({ conversations: chats(AI_SIDEBAR_CONVERSATIONS_MAX), more: false });
  const over = sidebarPage(chats(AI_SIDEBAR_CONVERSATIONS_MAX + 1));
  expect(over.conversations).toHaveLength(AI_SIDEBAR_CONVERSATIONS_MAX);
  expect(over.conversations.at(-1)).toBe(`chat-${AI_SIDEBAR_CONVERSATIONS_MAX - 1}`);
  expect(over.more).toBe(true);
  expect(sidebarPage([])).toEqual({ conversations: [], more: false });
});
