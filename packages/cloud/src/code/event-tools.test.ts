import { expect, test } from "bun:test";
import { CodeEventCatchupInputSchema } from "./event-tools";

const event = (id: string) => ({
  id: "00000000-0000-4000-8000-000000000001",
  type: "mail.message.received",
  version: 1,
  source: "mail",
  time: "2026-11-01T12:00:00Z",
  subject: { type: "mail.message", id },
  place: { type: "mail.mailbox", id: "Box123" },
  data: { receiptId: "00000000-0000-4000-8000-000000000002" },
});
const input = {
  operationId: "00000000-0000-4000-8000-000000000003",
  versionId: "00000000-0000-4000-8000-000000000004",
  events: [event("Msg123")],
};
test("historical snapshots require unique messages and bound item count and encoded bytes", () => {
  expect(CodeEventCatchupInputSchema.safeParse(input).success).toBe(true);
  expect(CodeEventCatchupInputSchema.safeParse({ ...input, events: [event("Msg123"), event("Msg123")] }).success).toBe(false);
  expect(
    CodeEventCatchupInputSchema.safeParse({ ...input, events: Array.from({ length: 101 }, (_, n) => event(`message${n}`)) }).success,
  ).toBe(false);
  expect(
    CodeEventCatchupInputSchema.safeParse({ ...input, events: [{ ...event("Msg123"), data: { text: "x".repeat(4096) } }] }).success,
  ).toBe(false);
  expect(
    CodeEventCatchupInputSchema.safeParse({
      ...input,
      events: Array.from({ length: 100 }, (_, n) => ({ ...event(`message${n}`), data: { value: "x".repeat(1000) } })),
    }).success,
  ).toBe(false);
});
