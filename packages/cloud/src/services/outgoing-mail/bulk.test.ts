import { expect, test } from "bun:test";
import { MailBatchSchema } from "../../contracts/outgoing-mail";
import { mailBacklogFull, mailBatchId, mailNextDrainDelay, mailSlotMs } from "./bulk";

const message = { to: ["reader@example.org"], subject: "Hello", text: "Hello" };
test("batch input rejects empty, oversized, invalid and duplicate-key calls", () => {
  for (const messages of [
    [],
    Array.from({ length: 1001 }, () => message),
    [
      { ...message, key: "same" },
      { ...message, key: "same" },
    ],
    [message, { ...message, to: [] }],
  ])
    expect(MailBatchSchema.safeParse(messages).success).toBe(false);
  expect(MailBatchSchema.safeParse(Array.from({ length: 1000 }, () => message)).success).toBe(true);
  expect(
    MailBatchSchema.safeParse([
      { ...message, key: "a" },
      { ...message, key: "A" },
    ]).success,
  ).toBe(true);
});
test("backlog allows exactly 24 hours at the profile pace", () => {
  expect(mailBacklogFull(1439, 1, 1)).toBe(false);
  expect(mailBacklogFull(1440, 1, 1)).toBe(true);
  expect(mailBacklogFull(86_399, 1, 60)).toBe(false);
  expect(mailBacklogFull(86_399, 2, 60)).toBe(true);
  expect(mailBacklogFull(9_000_000, 0, 1)).toBe(false);
});
test("pacing uses fractional milliseconds and waits for both retry and slot", () => {
  expect(mailSlotMs(1)).toBe(60_000);
  expect(mailSlotMs(60)).toBe(1000);
  expect(mailSlotMs(7)).toBeCloseTo(8571.428571);
  expect(mailSlotMs(6000)).toBe(10);
  expect(mailNextDrainDelay(1000, 4000, 2000)).toBe(3000);
  expect(mailNextDrainDelay(1000, 500, 500)).toBe(0);
  expect(mailNextDrainDelay(1000, 2000, 10_000)).toBe(9000);
});
test("coalesced continuations never delay fresh mail beyond the 30-second recovery interval", () => {
  expect(mailNextDrainDelay(1000, 2000, 1000 + 60 * 60_000)).toBe(30_000);
  expect(mailNextDrainDelay(1000, 61_000, 1000)).toBe(30_000);
});
test("batch id is reused only when every input was accepted in the same earlier batch", () => {
  const old = { batch_id: "old" };
  expect(mailBatchId("new", [old, old])).toBe("old");
  expect(mailBatchId("new", [old, undefined])).toBe("new");
  expect(mailBatchId("new", [old, { batch_id: "other" }])).toBe("new");
  expect(mailBatchId("new", [{ batch_id: null }])).toBe("new");
});
