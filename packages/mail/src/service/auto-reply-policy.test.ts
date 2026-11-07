import { describe, expect, test } from "bun:test";
import { type AutoReplyFacts, automatedMailReasons, evaluateAutoReplyPolicy, parseReturnPathAddress } from "./auto-reply-policy";

const inbound = (overrides: Partial<AutoReplyFacts> = {}): AutoReplyFacts => ({
  senderAddresses: ["customer@example.test"],
  mailboxAddresses: ["support@example.test"],
  returnPath: "<customer@example.test>",
  autoSubmitted: "no",
  ...overrides,
});

describe("evaluateAutoReplyPolicy", () => {
  test("allows an ordinary inbound message", () => {
    expect(evaluateAutoReplyPolicy(inbound())).toEqual({ allowed: true, reasons: [] });
  });

  test("blocks automated senders and null reverse paths", () => {
    expect(
      evaluateAutoReplyPolicy(
        inbound({
          returnPath: "<>",
          autoSubmitted: "auto-replied",
          autoResponseSuppress: "OOF, AutoReply",
        }),
      ),
    ).toEqual({
      allowed: false,
      reasons: ["null_return_path", "automated_message", "sender_suppressed"],
    });
  });

  test("blocks self replies, list traffic, and delivery reports", () => {
    expect(
      evaluateAutoReplyPolicy(
        inbound({
          senderAddresses: ["SUPPORT@example.test"],
          precedence: "bulk",
          listId: "announcements.example.test",
          deliveryStatus: true,
        }),
      ),
    ).toEqual({
      allowed: false,
      reasons: ["mailbox_sender", "bulk_message", "mailing_list", "delivery_status"],
    });
  });

  test("blocks duplicate replies and messages without a usable sender", () => {
    expect(evaluateAutoReplyPolicy(inbound({ senderAddresses: [], alreadyReplied: true }))).toEqual({
      allowed: false,
      reasons: ["missing_sender", "already_replied"],
    });
  });

  test("accepts exactly one non-null return path address", () => {
    expect(parseReturnPathAddress("<Sender@Example.test>")).toBe("sender@example.test");
    expect(parseReturnPathAddress("<>")).toBeNull();
    expect(parseReturnPathAddress("first@example.test, second@example.test")).toBeNull();
  });
});

test.each([
  { facts: {}, bulk: false },
  { facts: { autoSubmitted: " NO " }, bulk: false },
  { facts: { autoSubmitted: " Auto-Generated " }, bulk: true },
  { facts: { precedence: " BULK " }, bulk: true },
  { facts: { precedence: "list" }, bulk: true },
  { facts: { precedence: "Junk" }, bulk: true },
  { facts: { precedence: "normal" }, bulk: false },
  { facts: { listId: "Updates <updates.example.test>" }, bulk: true },
  { facts: { listId: " " }, bulk: false },
])("shares bulk classification with automatic-reply guards: %j", ({ facts, bulk }) => {
  expect(automatedMailReasons(facts).length > 0).toBe(bulk);
});
