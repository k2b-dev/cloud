import { expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { waitForMessageHydration } from "./message-readiness";

const start = Date.parse("2026-11-01T12:00:00Z");
test("ordinary pending and retryable failed hydration wait without consuming handler attempts", async () => {
  let time = start,
    reads = 0,
    waits = 0;
  const statuses = ["envelope", "headers", "failed", "body", "complete"];
  const result = await waitForMessageHydration({
    read: async () => ok({ hydrationStatus: statuses[reads++]!, receipt: "original" }),
    terminal: async () => false,
    signal: new AbortController().signal,
    now: () => time,
    wait: async (ms) => {
      time += ms;
      waits++;
    },
  });
  expect(result).toEqual(ok({ hydrationStatus: "complete", receipt: "original" }));
  expect(reads).toBe(5);
  expect(waits).toBe(4);
  expect(time - start).toBe(4_000);
});
test("one waiting read returns pending at its transport bound so the same handler can continue", async () => {
  let time = start,
    reads = 0;
  const read = () =>
    waitForMessageHydration({
      read: async () => {
        reads++;
        return ok({ hydrationStatus: "envelope" });
      },
      terminal: async () => false,
      signal: new AbortController().signal,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
    });
  expect(await read()).toEqual(ok({ hydrationStatus: "envelope" }));
  expect(time - start).toBe(30_000);
  expect(reads).toBe(31);
  expect(await read()).toEqual(ok({ hydrationStatus: "envelope" }));
  expect(time - start).toBe(60_000);
});
test("terminal hydration failure is explicit and performs no readiness retry", async () => {
  let waits = 0;
  expect(
    await waitForMessageHydration({
      read: async () => ok({ hydrationStatus: "failed" }),
      terminal: async () => true,
      signal: new AbortController().signal,
      now: () => start,
      wait: async () => {
        waits++;
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "MAIL_MESSAGE_HYDRATION_FAILED", status: 409 } });
  expect(waits).toBe(0);
});
test("each poll retains current read permissions", async () => {
  let time = start,
    reads = 0;
  const revoked = fail(err.forbidden("revoked"));
  expect(
    await waitForMessageHydration({
      read: async () => (++reads === 1 ? ok({ hydrationStatus: "body" }) : revoked),
      terminal: async () => false,
      signal: new AbortController().signal,
      now: () => time,
      wait: async (ms) => {
        time += ms;
      },
    }),
  ).toEqual(revoked);
  expect(reads).toBe(2);
});
test("the caller's original deadline cancels readiness waiting", async () => {
  const controller = new AbortController();
  let reads = 0;
  await expect(
    waitForMessageHydration({
      read: async () => {
        reads++;
        return ok({ hydrationStatus: "envelope" });
      },
      terminal: async () => false,
      signal: controller.signal,
      now: () => start,
      wait: async () => {
        controller.abort(new Error("original_deadline"));
      },
    }),
  ).rejects.toThrow("original_deadline");
  expect(reads).toBe(1);
});
