import { afterEach, expect, jest, test } from "bun:test";
import { CHAT_BADGE_PATH, createNotificationCleanup, type NotificationCleanupDependencies } from "./notification-cleanup";

const closed: Array<[string, string]> = [];
const badges: number[] = [];
let refreshed = 0;
const requests: string[] = [];
let answer: () => Response = () => Response.json({ count: 0 });
const dependencies: NotificationCleanupDependencies = {
  notifications: async () => ({
    closeGroup: async (appId, group) => void closed.push([appId, group]),
    setBadge: async (count) => void badges.push(count),
  }),
  refreshAppBadges: async () => void refreshed++,
  fetch: async (input) => {
    requests.push(input);
    return answer();
  },
};

const flush = async () => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
};
afterEach(() => {
  jest.useRealTimers();
  closed.length = 0;
  badges.length = 0;
  requests.length = 0;
  refreshed = 0;
});

test("read chats close their notification once, at start and when they become read; the badge follows the counts", async () => {
  jest.useFakeTimers();
  let count = 3;
  answer = () => Response.json({ count });
  const cleanup = createNotificationCleanup(dependencies);
  try {
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatNew002", unread: 4, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 1, summaryCursor: null },
    ]);
    await flush();
    expect(closed).toEqual([["chat", "ChatRead01"]]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(refreshed).toBe(1);
    expect(badges).toEqual([3]);

    // Unchanged rows neither close again nor read the badge again.
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatNew002", unread: 4, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 1, summaryCursor: null },
    ]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(closed).toHaveLength(1);
    expect(badges).toEqual([3]);

    // Reading elsewhere arrives as zero counts: the notification closes here, and several reads share one badge read.
    count = 1;
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatNew002", unread: 0, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 1, summaryCursor: null },
    ]);
    count = 0;
    cleanup([
      { id: "ChatRead01", unread: 0, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatNew002", unread: 0, mentionsUnread: 0, summaryCursor: null },
      { id: "ChatAt0003", unread: 0, mentionsUnread: 0, summaryCursor: null },
    ]);
    await flush();
    expect(closed.map(([, id]) => id)).toEqual(["ChatRead01", "ChatNew002", "ChatAt0003"]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(badges).toEqual([3, 0]);
    expect(requests).toEqual([CHAT_BADGE_PATH, CHAT_BADGE_PATH]);

    // A chat that gets new messages and is read again closes again.
    cleanup([{ id: "ChatNew002", unread: 2, mentionsUnread: 0, summaryCursor: null }]);
    cleanup([{ id: "ChatNew002", unread: 0, mentionsUnread: 0, summaryCursor: null }]);
    await flush();
    expect(closed.map(([, id]) => id)).toEqual(["ChatRead01", "ChatNew002", "ChatAt0003", "ChatNew002"]);
  } finally {
    cleanup.dispose();
  }
});

test("a failing badge route leaves the badge alone, and nothing runs after dispose", async () => {
  jest.useFakeTimers();
  answer = () => new Response("unavailable", { status: 503 });
  const cleanup = createNotificationCleanup(dependencies);
  try {
    cleanup([{ id: "ChatNew002", unread: 1, mentionsUnread: 0, summaryCursor: null }]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(badges).toEqual([]);
    cleanup.dispose();
    cleanup([{ id: "ChatNew002", unread: 0, mentionsUnread: 0, summaryCursor: null }]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(closed).toEqual([]);
    expect(requests).toHaveLength(1);
  } finally {
    cleanup.dispose();
  }
});

test("a partial summary never closes its chat, and a late older badge answer is dropped", async () => {
  jest.useFakeTimers();
  const answers: Array<(response: Response) => void> = [];
  const slow: NotificationCleanupDependencies = {
    ...dependencies,
    fetch: async (input) => {
      requests.push(input);
      return new Promise<Response>((resolve) => answers.push(resolve));
    },
  };
  const cleanup = createNotificationCleanup(slow);
  try {
    cleanup([{ id: "ChatSpace01", unread: 0, mentionsUnread: 0, summaryCursor: "next" }]);
    await flush();
    expect(closed).toEqual([]);
    jest.advanceTimersByTime(1_000);
    await flush();
    cleanup([{ id: "ChatSpace01", unread: 2, mentionsUnread: 0, summaryCursor: "next" }]);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(answers).toHaveLength(2);
    // The newer read answers first; the older one arrives later and must not undo it.
    answers[1]!(Response.json({ count: 0 }));
    await flush();
    answers[0]!(Response.json({ count: 1 }));
    await flush();
    expect(badges).toEqual([0]);
  } finally {
    cleanup.dispose();
  }
});
