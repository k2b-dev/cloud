import { expect, spyOn, test } from "bun:test";
import { ConflictError, type Mutex } from "@k2b/sync";
import { createSharedTextAdmission } from "./admission";

const mutex = (available: () => boolean = () => true): Pick<Mutex, "withLock"> => ({
  async withLock(input, run) {
    return available()
      ? run({ resource: input.resource, ownerToken: "test", fence: 1n, expiresAt: new Date("2026-11-13T01:00:00Z") })
      : null;
  },
});

test("same-document admissions queue FIFO without retrying the broker; other documents proceed", async () => {
  const admit = createSharedTextAdmission(() => mutex());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: number[] = [];
  const first = admit("one", undefined, async () => {
    entered.resolve();
    await release.promise;
    order.push(1);
  });
  await entered.promise;
  const second = admit("one", undefined, async () => {
    order.push(2);
  });
  const third = admit("one", undefined, async () => {
    order.push(3);
  });
  await admit("other", undefined, async () => {
    order.push(0);
  });
  expect(order).toEqual([0]);
  release.resolve();
  await Promise.all([first, second, third]);
  expect(order).toEqual([0, 1, 2, 3]);
});

test("contended broker acquisition backs off with jitter and has bounded attempts", async () => {
  const random = spyOn(Math, "random").mockReturnValue(0);
  let attempts = 0;
  const admit = createSharedTextAdmission(() =>
    mutex(() => {
      attempts++;
      return false;
    }),
  );
  try {
    await expect(
      admit("doc", undefined, async () => {
        throw new Error("No admission");
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(attempts).toBe(16);
  } finally {
    random.mockRestore();
  }
});

test("a canceled queued editor never enters and does not block the next editor", async () => {
  const admit = createSharedTextAdmission(() => mutex());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = admit("doc", undefined, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const abort = new AbortController();
  const canceled = admit("doc", abort.signal, async () => {
    throw new Error("Canceled editor entered");
  });
  abort.abort(new Error("cancel"));
  await expect(canceled).rejects.toThrow("cancel");
  const next = admit("doc", undefined, async () => "resumed");
  release.resolve();
  await first;
  expect(await next).toBe("resumed");
});
