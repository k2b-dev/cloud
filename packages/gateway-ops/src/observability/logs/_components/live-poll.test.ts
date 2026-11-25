import { expect, test } from "bun:test";
import { liveDelay, startLivePoll } from "./live-poll";

/** A clock the test moves by hand: timers fire only when it says so. */
const manualTimers = () => {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, run });
        return id;
      },
      clear: (id: unknown) => void pending.delete(id as number),
    },
    /** Moves the clock and runs every timer that is due, then lets their promises settle. */
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.run();
      }
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    },
    pending: () => pending.size,
  };
};

test("the delay doubles after each failure up to its ceiling and returns to the interval after a success", () => {
  expect([0, 1, 2, 3, 4, 5].map((failures) => liveDelay(failures, 5_000, 60_000))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
});

test("the next refresh is planned only after the running one answered", async () => {
  const clock = manualTimers();
  let answer: (ok: boolean) => void = () => {};
  let started = 0;
  const poll = startLivePoll({
    interval: 5_000,
    maxDelay: 60_000,
    ready: () => true,
    poll: () => {
      started += 1;
      return new Promise<boolean>((done) => {
        answer = done;
      });
    },
    timers: clock.timers,
  });
  await clock.advance(5_000);
  expect(started).toBe(1);
  // a slow answer: no second refresh is waiting meanwhile
  await clock.advance(20_000);
  expect(started).toBe(1);
  expect(clock.pending()).toBe(0);
  answer(true);
  await clock.advance(0);
  await clock.advance(5_000);
  expect(started).toBe(2);
  poll.stop();
});

test("failures back off and a success returns to the interval; a paused poll asks nothing", async () => {
  const clock = manualTimers();
  const results = [false, false, true];
  let started = 0;
  let ready = true;
  const poll = startLivePoll({
    interval: 5_000,
    maxDelay: 60_000,
    ready: () => ready,
    poll: async () => {
      started += 1;
      return results.shift() ?? true;
    },
    timers: clock.timers,
  });
  await clock.advance(5_000);
  expect(started).toBe(1);
  await clock.advance(9_999);
  expect(started).toBe(1);
  await clock.advance(1);
  expect(started).toBe(2);
  await clock.advance(20_000);
  expect(started).toBe(3);
  await clock.advance(5_000);
  expect(started).toBe(4);
  // hidden or offline: the poll waits without asking, and resumes at once when woken
  ready = false;
  await clock.advance(30_000);
  expect(started).toBe(4);
  ready = true;
  poll.wake();
  await clock.advance(0);
  expect(started).toBe(5);
  poll.stop();
  await clock.advance(60_000);
  expect(started).toBe(5);
  expect(clock.pending()).toBe(0);
});
