import { expect, test } from "bun:test";
import type { Context } from "hono";
import { MAILBOX_CODE_ATTENTION_GRACE_MS, startMailboxCodeAttention } from "./code-attention";

const c = {} as Context;

test("Core down or slow: the mailbox waits at most the grace period and renders without a dot", async () => {
  // Core never answers in time: the helper's own timeout would resolve null later; the page does not wait for it.
  const slow = startMailboxCodeAttention(c, "Mb4kd2", () => new Promise(() => {}));
  const started = performance.now();
  expect(await slow.settle()).toBeNull();
  expect(performance.now() - started).toBeLessThan(MAILBOX_CODE_ATTENTION_GRACE_MS + 250);
  // Core down: the shared helper resolves null, never throws.
  expect(await startMailboxCodeAttention(c, "Mb4kd2", async () => null).settle()).toBeNull();
  // A quick answer is used, for exactly this mailbox.
  let asked: unknown;
  const quick = startMailboxCodeAttention(c, "Mb4kd2", async (_c, ref) => {
    asked = ref;
    return { visible: true, attention: true };
  });
  expect(await quick.settle()).toEqual({ visible: true, attention: true });
  expect(asked).toEqual({ type: "mail.mailbox", id: "Mb4kd2" });
});
