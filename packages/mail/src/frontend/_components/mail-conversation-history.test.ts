import { describe, expect, test } from "bun:test";
import {
  initialConversationMessageId,
  isNearConversationEnd,
  isNearConversationStart,
  isOutgoingMessage,
  mergeLatestMessagePages,
} from "./mail-conversation-history";

const identities = [{ fromAddress: "me@example.com", status: "verified" }];

describe("mail conversation history", () => {
  test("recognizes outgoing messages only through verified sender identities", () => {
    expect(isOutgoingMessage({ from: [{ address: "ME@example.com" }] }, identities)).toBeTrue();
    expect(isOutgoingMessage({ from: [{ address: "me@example.com" }] }, [{ ...identities[0]!, status: "pending" }])).toBeFalse();
  });

  test("opens the newest message, which is the last one in reading order", () => {
    const messages = [
      { id: "read", from: [{ address: "sender@example.com" }], flags: ["\\Seen"] },
      { id: "outgoing", from: [{ address: "me@example.com" }], flags: [] },
      { id: "unread", from: [{ address: "sender@example.com" }], flags: [] },
      { id: "newest", from: [{ address: "sender@example.com" }], flags: ["\\Seen"] },
    ];

    expect(initialConversationMessageId(messages)).toBe("newest");
    expect(messages.map((message) => message.id)).toEqual(["read", "outgoing", "unread", "newest"]);
    expect(initialConversationMessageId([])).toBeNull();
  });

  test("follows live messages only while the reader is near the end, where the newest message is", () => {
    expect(isNearConversationEnd({ scrollTop: 860, scrollHeight: 1500, clientHeight: 600 })).toBeTrue();
    expect(isNearConversationEnd({ scrollTop: 700, scrollHeight: 1500, clientHeight: 600 })).toBeFalse();
    expect(isNearConversationEnd({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 })).toBeTrue();
  });

  test("with the reply box on top, follows live messages only while the reader is near the start", () => {
    expect(isNearConversationStart({ scrollTop: 0 })).toBeTrue();
    expect(isNearConversationStart({ scrollTop: 96 })).toBeTrue();
    expect(isNearConversationStart({ scrollTop: 97 })).toBeFalse();
  });

  test("merges latest-first pages without duplicating cursor boundary messages", () => {
    const pages = [{ items: [{ id: "older" }, { id: "newest" }] }, { items: [{ id: "oldest" }, { id: "older" }] }];

    expect(mergeLatestMessagePages(pages).map((message) => message.id)).toEqual(["newest", "older", "oldest"]);
  });
});
