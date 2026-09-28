import { expect, test } from "bun:test";
import { drain, MAX_DEFERRED_REQUESTS, run } from "./deferred";

test("deferred requests are bounded, drop the excess, recover and drain", async () => {
  const release = Promise.withResolvers<void>();
  let started = 0;
  let finished = 0;
  const blocked = async () => {
    started++;
    await release.promise;
    finished++;
  };

  const accepted = Array.from({ length: MAX_DEFERRED_REQUESTS }, () => run("Test request", blocked));
  expect(started).toBe(MAX_DEFERRED_REQUESTS);

  // A full backlog drops new work without starting it; the caller still gets a settled promise.
  let droppedRan = false;
  await run("Test request", async () => {
    droppedRan = true;
  });
  expect(droppedRan).toBe(false);

  const drained = drain().then(() => finished);
  release.resolve();
  expect(await drained).toBe(MAX_DEFERRED_REQUESTS);
  await Promise.all(accepted);

  // Once the backlog shrinks, work is accepted again and failures never reject.
  let recovered = false;
  await run("Test request", async () => {
    recovered = true;
  });
  expect(recovered).toBe(true);
  await expect(
    run("Test request", async () => {
      throw new Error("backend down");
    }),
  ).resolves.toBeUndefined();
});
