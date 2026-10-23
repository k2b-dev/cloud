import { expect, test } from "bun:test";
import { ConversationSchema, ThreadSchema } from "../service/contracts";
import { completeSystemSummary } from "./system-chats";
import { chatHasThreads, systemThreadRows } from "./threads";

const at = "2026-10-14T12:00:00.000Z";
const conversation = ConversationSchema.parse({
  id: "System",
  kind: "system",
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

test("summary continuations add counts and keep the latest message without counting General twice", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({
        ...conversation,
        threads: 3,
        unread: 5,
        summaryCursor: null,
        lastMessage: {
          thread: { id: "Thread", name: "Task" },
          id: "Message001",
          author: { id: "11111111-1111-4111-8111-111111111111", name: "Nora", type: "user" },
          preview: "Latest",
          createdAt: at,
        },
      });
    },
    { preconnect: original.preconnect },
  );
  try {
    const result = await completeSystemSummary(conversation, new AbortController().signal);
    expect(result).toMatchObject({ threads: 5, unread: 9, summaryCursor: null, lastMessage: { preview: "Latest" } });
    expect(new URL(requests[0]!, "https://test.invalid").searchParams.get("summaryCursor")).toBe("Page01");
  } finally {
    globalThis.fetch = original;
  }
});

test("a budget-exhausted empty cursor starts the summary and caps unread at the public limit", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({ ...conversation, unread: 100, threads: 101, summaryCursor: null });
    },
    { preconnect: original.preconnect },
  );
  try {
    expect(
      await completeSystemSummary({ ...conversation, threads: 0, unread: 0, summaryCursor: "" }, new AbortController().signal),
    ).toMatchObject({ threads: 101, unread: 100, summaryCursor: null });
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});

test("repeated summary cursors fail visibly instead of looping", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json(conversation);
    },
    { preconnect: original.preconnect },
  );
  try {
    await expect(completeSystemSummary(conversation, new AbortController().signal)).rejects.toThrow("Repeated chat summary cursor");
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
  }
});
