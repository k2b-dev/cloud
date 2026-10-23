import { expect, test } from "bun:test";
import { ConversationSchema, ThreadSchema } from "../service/contracts";
import { loadSystemChats } from "./system-chats";
import { chatHasThreads, systemThreadRows } from "./threads";

const at = "2026-10-14T12:00:00.000Z";
const conversation = ConversationSchema.parse({
  id: "System",
  kind: "system",
  channel: false,
  member: false,
  resource: { type: "spaces.space", id: "Space1" },
  name: "Space",
  title: "Space",
  purpose: null,
  icon: null,
  memberCount: 2,
  unread: 4,
  read: null,
  threads: 2,
  withGuests: false,
  peerDeactivated: false,
  permission: "write",
  rev: 1,
  createdAt: at,
  lastActivityAt: at,
  lastMessage: null,
  summaryCursor: "Page01",
});

test("a system chat with no item threads still has All threads", () => {
  expect(chatHasThreads({ threads: 0, kind: "system" })).toBe(true);
  expect(chatHasThreads({ threads: 0 })).toBe(false);
});

test("short list is the activity-ordered union of four recent, unread and selected threads", () => {
  const items = Array.from({ length: 8 }, (_, index) =>
    ThreadSchema.parse({
      id: `Item0${index}`,
      name: `Item ${index}`,
      description: null,
      archived: false,
      unread: index === 1 ? 2 : 0,
      read: null,
      lastMessage: null,
      createdAt: at,
      lastActivityAt: new Date(Date.UTC(2026, 9, 14, index)).toISOString(),
    }),
  );
  expect(systemThreadRows({ general: { unread: 0, lastMessage: null }, items }, "Item00").map((item) => item.id)).toEqual([
    "Item07",
    "Item06",
    "Item05",
    "Item04",
    "Item01",
    "Item00",
  ]);
});

test("loading a sidebar page does not exhaust any conversation summary", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return calls === 1
        ? Response.json({ items: [{ ref: conversation.resource, name: "Space", conversation }], spacesCursor: null, notebooksCursor: null })
        : Response.json({ ...conversation, summaryCursor: null });
    },
    { preconnect: original.preconnect },
  );
  try {
    const page = await loadSystemChats({}, new AbortController().signal);
    expect(calls).toBe(1);
    expect(page.items[0]?.conversation?.summaryCursor).toBe("Page01");
  } finally {
    globalThis.fetch = original;
  }
});
