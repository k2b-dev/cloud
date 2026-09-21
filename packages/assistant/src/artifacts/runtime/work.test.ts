import { expect, test } from "bun:test";
import { createWork, type WorkState } from "./work";

test("work reports failure before the error hook and releases ownership", async () => {
  const events: string[] = [];
  const work = createWork(
    (state) => events.push(state.status),
    () => {},
    () => events.push("error-hook"),
  );
  const failed = work.run(async () => {
    throw new Error("broken");
  });
  expect(() => work.run(async () => 1)).toThrow("already running");
  await expect(failed.done).rejects.toThrow("broken");
  expect(events.indexOf("error")).toBeLessThan(events.indexOf("error-hook"));
  expect(await work.run(async () => 42).done).toBe(42);
});
test("cooperative cancellation is distinct from failure", async () => {
  const states: WorkState[] = [];
  let errors = 0;
  const work = createWork(
    (state) => states.push(state),
    () => {},
    () => errors++,
  );
  const job = work.run(async (context) => {
    await context.checkpoint();
    return 1;
  });
  job.cancel();
  await expect(job.done).rejects.toThrow("cancelled");
  expect(states.at(-1)?.status).toBe("cancelled");
  expect(errors).toBe(0);
});
