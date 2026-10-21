import { expect, test } from "bun:test";
import type { AiPendingTurnAction } from "@k2b/cloud/ai";
import type { CapabilityActionCallReview } from "@k2b/cloud/contracts/capabilities";
import { pendingActionQuestion, printPendingActionContent } from "./action-question";

const ctx = { options: { profile: "test", server: "https://cloud.example", token: "test", output: "text" as const, locale: "en" } };
const people = ["a", "b", "c", "d"].map((name) => ({ name, address: `${name}@example.com` }));
const review = (overrides: Partial<CapabilityActionCallReview> = {}): CapabilityActionCallReview => ({
  locale: "en",
  ask: "sends",
  sentence: { action: "Send to {to}", running: "Sending to {to}", done: "Sent to {to}", confirm: "Send", decline: "Don't send" },
  slots: { to: { kind: "person", people } },
  ...overrides,
});
const action = (value?: CapabilityActionCallReview): Extract<AiPendingTurnAction, { type: "approval_request" }> => ({
  type: "approval_request",
  turnId: "turn",
  conversationId: "chat",
  callId: "call",
  name: "mail__action__draft_dot_send",
  args: { to: people.map((person) => person.address) },
  message: "Send draft",
  ...(value ? { review: value } : {}),
  allowAlways: false,
  allowChat: false,
});

test("the input shows without a review, and when the question leaves something out that no link opens", () => {
  expect(pendingActionQuestion(ctx, action()).showInput).toBe(true);
  const elided = pendingActionQuestion(ctx, action(review()));
  expect(elided.lines[0]).toBe("? Send to a <a@example.com>, b <b@example.com>, c <c@example.com>, and 1 more?");
  expect(elided.showInput).toBe(true);
  expect(pendingActionQuestion(ctx, action(review({ links: [{ rel: "open", href: "/mail/drafts/1" }] }))).showInput).toBe(false);
  expect(pendingActionQuestion(ctx, action(review({ slots: { to: { kind: "person", people: people.slice(0, 2) } } }))).showInput).toBe(
    false,
  );
  // An old review cannot say whether it shortened anything.
  const legacy = { message: "Create note", details: [{ label: "Text", value: "Shortened…" }] };
  expect(pendingActionQuestion(ctx, { ...action(), review: legacy }).showInput).toBe(true);
});

test("terminal full content preserves valid JSON, complete text and invisible source characters", async () => {
  const content = { kind: "page", title: "Proposal", body: `${"x".repeat(80_000)}\u0000\u202e\ud800\u{e0001}`, format: "plain" };
  const pending = action();
  pending.review = {
    ...review(),
    contentRef: { href: "/api/approvals/11111111-1111-4111-8111-111111111111/content", digest: "a".repeat(64) },
  };
  const printed: string[] = [];
  await printPendingActionContent(
    {
      fetch: async () => Response.json(content),
      print: (text) => {
        printed.push(text ?? "");
      },
    },
    pending,
  );
  expect(printed).toHaveLength(1);
  expect(JSON.parse(printed[0]!)).toEqual(content);
  expect(printed[0]).not.toContain("\u202e");
  await expect(
    printPendingActionContent(
      {
        fetch: async () => new Response("denied", { status: 403 }),
        print: () => {
          throw new Error("Must not print unavailable content");
        },
      },
      pending,
    ),
  ).rejects.toThrow();
});
