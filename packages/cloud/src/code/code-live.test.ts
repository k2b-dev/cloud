import { afterEach, expect, spyOn, test } from "bun:test";
import * as live from "../browser/live";
import { followCodeRuns } from "../ssr/code-page/code-live";
import { CodeRunEventSchema } from "./live-events";

const event = {
  type: "code.run" as const,
  runId: "11111111-1111-4111-8111-111111111111",
  state: "running" as const,
  at: "2026-11-14T12:00:00.000Z",
};
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("Code run hints contain only a stable ID, state and timestamp", () => {
  expect(CodeRunEventSchema.parse(event)).toEqual(event);
  for (const extra of [{ payload: "private" }, { name: "private" }, { state: "cancelled" }, { at: "today" }])
    expect(CodeRunEventSchema.safeParse({ ...event, ...extra }).success).toBe(false);
});

test("the cross-app helper follows Core, forwards hints, separates resync, and disposes", async () => {
  let deliver = async (_data: unknown) => {};
  let resync = async () => {};
  let caughtUp = (_value: boolean) => {};
  let closed = false;
  const calls: unknown[] = [];
  const spy = spyOn(live, "liveConnection").mockImplementation((url) => {
    calls.push(url);
    return {
      subscribe: (channel, scope, handlers) => {
        calls.push({ channel, scope, cursor: handlers.cursor });
        deliver = async (data) => handlers.apply([{ data: handlers.parse(data), cursor: "cursor" }]);
        resync = handlers.resync;
        caughtUp = (value) => handlers.caughtUp?.(value);
        return {
          close: () => {
            closed = true;
          },
        };
      },
    };
  });
  spies.push(spy);
  const runs: unknown[] = [];
  let reloads = 0;
  const stop = followCodeRuns(
    "c_test",
    (run) => {
      runs.push(run);
    },
    () => {
      reloads++;
    },
  );
  expect(calls).toEqual(["/api/ai/live", { channel: "code", scope: { codeId: "c_test" }, cursor: null }]);
  caughtUp(false);
  expect(reloads).toBe(0);
  caughtUp(true);
  await Promise.resolve();
  expect(reloads).toBe(1);
  await deliver(event);
  expect(runs).toEqual([{ runId: event.runId, state: event.state, at: event.at }]);
  await resync();
  expect(reloads).toBe(2);
  caughtUp(false);
  caughtUp(true);
  expect(reloads).toBe(2);
  expect(runs).toHaveLength(1);
  stop();
  expect(closed).toBe(true);
  await deliver(event);
  expect(runs).toHaveLength(1);
});
