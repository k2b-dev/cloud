import { expect, test } from "bun:test";
import { type QueueSendResult, sendQueuedEntryNow } from "./queue-send";

const lost = async (): Promise<never> => {
  throw new Error("network");
};
const run = (send: () => Promise<QueueSendResult>, receipt: () => Promise<QueueSendResult | null> = lost) => {
  const calls: string[] = [];
  const outcome = sendQueuedEntryNow({
    send,
    receipt: () => {
      calls.push("receipt");
      return receipt();
    },
    reload: async () => {
      calls.push("reload");
    },
  });
  return outcome.then((value) => ({ outcome: value, calls }));
};

test("Cloud's answer decides, and the queue is read again", async () => {
  expect(await run(async () => ({ state: "submitted" }))).toEqual({ outcome: "sent", calls: ["reload"] });
  expect(await run(async () => ({ state: "sending" }))).toEqual({ outcome: "sent", calls: ["reload"] });
  expect(await run(async () => ({ state: "failed" }))).toEqual({ outcome: "not-sent", calls: ["reload"] });
});

test("a lost answer asks for the receipt and never claims a send it cannot prove", async () => {
  expect(await run(lost, async () => ({ state: "submitted" }))).toEqual({ outcome: "sent", calls: ["receipt", "reload"] });
  expect(await run(lost, async () => ({ state: "sending" }))).toEqual({ outcome: "sent", calls: ["receipt", "reload"] });
  // Still waiting, unknown, or no answer at all: not sent, so "Send again" may use the same ID.
  expect(await run(lost, async () => ({ state: "failed" }))).toEqual({ outcome: "not-sent", calls: ["receipt", "reload"] });
  expect(await run(lost, async () => null)).toEqual({ outcome: "not-sent", calls: ["receipt", "reload"] });
  expect(await run(lost, lost)).toEqual({ outcome: "not-sent", calls: ["receipt", "reload"] });
});
