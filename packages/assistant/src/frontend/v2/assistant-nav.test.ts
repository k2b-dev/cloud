import { expect, test } from "bun:test";
import { chatListEntries } from "./assistant-nav";

// Where the list of every chat is offered. The sidebar lists only open chats without a place, so a person with only
// archived (or done, or place) chats still needs the way to the full list.
test("All chats stays while the person has any chat, also only archived ones, and leaves only when there is none", () => {
  expect(chatListEntries({ more: false, anyChats: true })).toEqual({ allChats: true, moreChats: false });
  expect(chatListEntries({ more: false, anyChats: false })).toEqual({ allChats: false, moreChats: false });
  // More open chats than the sidebar holds: one entry at the list's end says it, not a second at the top.
  expect(chatListEntries({ more: true, anyChats: true })).toEqual({ allChats: false, moreChats: true });
});
