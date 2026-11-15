import { expect, test } from "bun:test";
import { sendQueuedEntryNow } from "./queue-send";

const entry = (id: string, state = "pending") => ({ id, state });

test("a confirmed send leaves the entry to the refreshed queue", async () => {
  const reloads: string[] = [];
  const outcome = await sendQueuedEntryNow({
    id: "q1",
    send: async () => ({ state: "submitted" }),
    reload: async () => {
      reloads.push("reload");
      return [entry("q2")];
    },
  });
  expect(outcome).toBe("sent");
  expect(reloads).toEqual(["reload"]);
});

test("a refused send stays queued and reads as not sent", async () => {
  expect(await sendQueuedEntryNow({ id: "q1", send: async () => ({ state: "failed" }), reload: async () => [entry("q1")] })).toBe(
    "not-sent",
  );
});

test("an unclear outcome reconciles first and never claims a send the queue contradicts", async () => {
  const lost = async () => {
    throw new Error("network");
  };
  // Still waiting: not sent, so "Send again" may use the same ID.
  expect(await sendQueuedEntryNow({ id: "q1", send: lost, reload: async () => [entry("q1"), entry("q2")] })).toBe("not-sent");
  // Left the queue, or Cloud is sending it: it went out; nothing is offered twice.
  expect(await sendQueuedEntryNow({ id: "q1", send: lost, reload: async () => [entry("q2")] })).toBe("sent");
  expect(await sendQueuedEntryNow({ id: "q1", send: lost, reload: async () => [entry("q1", "sending")] })).toBe("sent");
  // Without any answer, the entry stays and offers "Send again" with its own ID.
  expect(await sendQueuedEntryNow({ id: "q1", send: lost, reload: lost })).toBe("not-sent");
});
