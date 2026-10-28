import { afterEach, expect, jest, mock, spyOn, test } from "bun:test";

const closed: Array<[string, string]> = [];
const badges: number[] = [];
let refreshed = 0;
mock.module("@k2b/cloud/browser/notifications", () => ({
  browserNotificationClient: {
    closeGroup: async (appId: string, group: string) => void closed.push([appId, group]),
    setBadge: async (count: number) => void badges.push(count),
  },
}));
mock.module("@k2b/cloud/browser/app-badges", () => ({ refreshAppBadges: () => void refreshed++ }));
const { CHAT_BADGE_PATH, createNotificationCleanup } = await import("./notification-cleanup");

const flush = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};
afterEach(() => {
  jest.useRealTimers();
  closed.length = 0;
  badges.length = 0;
  refreshed = 0;
});

test("read chats close their notification once, at start and when they become read; the badge follows the counts", async () => {
  jest.useFakeTimers();
  let count = 3;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        expect(String(input)).toBe(CHAT_BADGE_PATH);
        return Response.json({ count });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const cleanup = createNotificationCleanup();
  try {
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0 },
      { id: "ChatNew002", unread: 4, mentionsUnread: 0 },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 1 },
    ]);
    await flush();
    expect(closed).toEqual([["chat", "ChatRead01"]]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(refreshed).toBe(1);
    expect(badges).toEqual([3]);

    // Unchanged rows neither close again nor read the badge again.
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0 },
      { id: "ChatNew002", unread: 4, mentionsUnread: 0 },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 1 },
    ]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(closed).toHaveLength(1);
    expect(badges).toEqual([3]);

    // Reading elsewhere arrives as zero counts: the notification closes here, and several reads share one badge read.
    count = 1;
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0 },
      { id: "ChatNew002", unread: 0, mentionsUnread: 0 },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 1 },
    ]);
    count = 0;
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0 },
      { id: "ChatNew002", unread: 0, mentionsUnread: 0 },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 0 },
    ]);
    await flush();
    expect(closed.map(([, id]) => id)).toEqual(["ChatRead01", "ChatNew002", "ChatAt0003"]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(badges).toEqual([3, 0]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // A chat that gets new messages and is read again closes again.
    cleanup([{ id: "ChatNew002", unread: 2, mentionsUnread: 0 }]);
    cleanup([{ id: "ChatNew002", unread: 0, mentionsUnread: 0 }]);
    await flush();
    expect(closed.map(([, id]) => id)).toEqual(["ChatRead01", "ChatNew002", "ChatAt0003", "ChatNew002"]);
  } finally {
    cleanup.dispose();
    fetchSpy.mockRestore();
  }
});

test("a failing badge route leaves the badge alone, and nothing runs after dispose", async () => {
  jest.useFakeTimers();
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response("unavailable", { status: 503 }), { preconnect: globalThis.fetch.preconnect }),
  );
  const cleanup = createNotificationCleanup();
  try {
    cleanup([{ id: "ChatNew002", unread: 1, mentionsUnread: 0 }]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(badges).toEqual([]);
    cleanup.dispose();
    cleanup([{ id: "ChatNew002", unread: 0, mentionsUnread: 0 }]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(closed).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
  }
});
