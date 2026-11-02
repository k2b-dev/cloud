import { expect, test } from "bun:test";
import { startEventDispatcher } from "./runtime";

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a hint arriving during a pass survives and bursts coalesce", async () => {
  const blocked = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const dispatcher = startEventDispatcher(
    {
      work: async () => {
        maximum = Math.max(maximum, ++active);
        if (++calls === 1) await blocked.promise;
        active--;
        return 0;
      },
      checkGap: async () => {},
      retain: async () => {},
    },
    () => {},
  );
  try {
    await settled();
    for (let i = 0; i < 100; i++) dispatcher.wake();
    blocked.resolve();
    await settled();
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
  } finally {
    blocked.resolve();
    await dispatcher.stop();
  }
});

test("committed backlog drains without waiting for another signal or safety scan", async () => {
  let calls = 0;
  const dispatcher = startEventDispatcher(
    {
      work: async () => (++calls < 4 ? 100 : 0),
      checkGap: async () => {},
      retain: async () => {},
    },
    () => {},
  );
  try {
    await settled();
    expect(calls).toBe(4);
  } finally {
    await dispatcher.stop();
  }
});

test("stop drains the active pass and refuses further hints", async () => {
  const blocked = Promise.withResolvers<void>();
  let calls = 0;
  let stopped = false;
  const dispatcher = startEventDispatcher(
    {
      work: async () => {
        calls++;
        await blocked.promise;
        return 100;
      },
      checkGap: async () => {},
      retain: async () => {},
    },
    () => {},
  );
  await settled();
  const stop = dispatcher.stop().then(() => {
    stopped = true;
  });
  dispatcher.wake();
  expect(stopped).toBe(false);
  blocked.resolve();
  await stop;
  dispatcher.wake();
  await settled();
  expect(calls).toBe(1);
});

test("a failed pass is visible and a subsequent hint can recover", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const dispatcher = startEventDispatcher(
    {
      work: async () => {
        if (++calls === 1) throw new Error("database unavailable");
        return 0;
      },
      checkGap: async () => {},
      retain: async () => {},
    },
    (error) => errors.push(error),
  );
  try {
    await settled();
    expect(errors).toHaveLength(1);
    dispatcher.wake();
    await settled();
    expect(calls).toBe(2);
  } finally {
    await dispatcher.stop();
  }
});
