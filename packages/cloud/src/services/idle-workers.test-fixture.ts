// Run in its own process: module doubles must never replace another suite's clients.

import { mock, setSystemTime } from "bun:test";
import assert from "node:assert/strict";

const epoch = Date.parse("2026-11-02T12:00:00Z");
setSystemTime(epoch);
let now = epoch;
const timers = new Set<{ timer: ReturnType<typeof setInterval>; every?: number; next: number; run: () => void }>();
const realInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
Object.defineProperty(globalThis, "setInterval", {
  value: (callback: () => void, every = 0) => {
    assert.equal(typeof callback, "function");
    const timer = realInterval(() => {}, 2 ** 30);
    realClearInterval(timer);
    timers.add({ timer, every, next: now + every, run: () => callback() });
    return timer;
  },
});
Object.defineProperty(globalThis, "clearInterval", {
  value: (timer: ReturnType<typeof setInterval>) => {
    for (const entry of timers) if (entry.timer === timer) timers.delete(entry);
  },
});
Object.defineProperty(globalThis, "setTimeout", {
  value: (callback: () => void, delay = 0) => {
    const timer = realInterval(() => {}, 2 ** 30);
    realClearInterval(timer);
    timers.add({ timer, next: now + delay, run: callback });
    return timer;
  },
});
Object.defineProperty(globalThis, "clearTimeout", { value: globalThis.clearInterval });
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
const advance = async (ms: number) => {
  const end = now + ms;
  for (;;) {
    const next = Math.min(...[...timers].map((entry) => entry.next));
    if (next > end) break;
    now = next;
    setSystemTime(now);
    for (const entry of timers) {
      if (entry.next !== now) continue;
      if (entry.every === undefined) timers.delete(entry);
      else entry.next += entry.every;
      entry.run();
    }
    await settled();
  }
  now = end;
  setSystemTime(now);
};

let polls = 0;
let pending: Array<{ id: string; attempts: number }> = [];
let pendingDue: number | undefined;
const query = Object.assign(
  async (parts: TemplateStringsArray) =>
    parts.join("").includes("AS wake_after_ms")
      ? [{ wake_after_ms: pendingDue !== undefined && pendingDue > now ? pendingDue - now : null }]
      : [],
  { unsafe: (value: string) => value, array: (value: string[]) => value },
);
const sql = Object.assign(query, {
  begin: async (run: (tx: typeof query) => Promise<unknown>) => {
    polls++;
    await run(query);
    return pendingDue !== undefined && pendingDue > now ? [] : pending.splice(0);
  },
});
mock.module("../runtime/clients", () => ({ sql }));
const listeners = new Map<string, Set<() => void>>();
const pgOutboxKey = (table: string) => `${table}:{}`;
mock.module("../_internal/work-wake", () => ({
  workWakeOrigin: "idle-budget",
  pgOutboxKey,
  notifyPgOutbox: () => {},
  notifyWork: (key: string) => {
    for (const wake of listeners.get(key) ?? []) wake();
  },
  subscribeWorkWake: (key: string, wake: () => void) => {
    const group = listeners.get(key) ?? new Set();
    listeners.set(key, group);
    group.add(wake);
    return () => group.delete(wake);
  },
}));
mock.module("../_internal/process-sync", () => ({
  lazySync: () => () => ({
    live: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    publish: async () => {},
  }),
}));

const { liveOutbox } = await import("../events/live-delivery");
const { appEventOutbox } = await import("../events/app-event-delivery");
let delivered = 0;
const outbox = liveOutbox("idle-budget", async () => {
  delivered++;
});
outbox.start();
await settled();
assert.equal(polls, 1, "one startup claim");
polls = 0;
await advance(60_000);
assert.equal(polls, 12, "outbox: at most 12 idle DB claims per minute");
// An independent writer's signal, received while an empty claim is still active.
let releaseClaim = () => {};
const blocked = new Promise<void>((resolve) => {
  releaseClaim = resolve;
});
const begin = sql.begin;
let emptyClaim = true;
sql.begin = async (run) => {
  if (!emptyClaim) return begin(run);
  emptyClaim = false;
  const rows = await begin(run); // Snapshot is empty before the independent writer commits.
  await blocked;
  return rows;
};
const inFlight = outbox.reconcile();
await settled();
pending.push({ id: "committed", attempts: 0 });
listeners.get("events.outbox:{}")?.forEach((wake) => wake());
releaseClaim();
await inFlight;
assert.equal(delivered, 1, "hint during active pass is retained");
sql.begin = begin;
pending.push({ id: "missed-hint", attempts: 0 });
await advance(5_000);
assert.equal(delivered, 2, "a missed hint loses no committed work: safety scan recovers it");
await outbox.stop();
const stoppedPolls = polls;
await advance(60_000);
assert.equal(polls, stoppedPolls, "stopped outbox never polls");
assert.equal(
  [...listeners.values()].reduce((n, group) => n + group.size, 0),
  0,
);

pending = [{ id: "retry-after-restart", attempts: 1 }];
pendingDue = now + 2_000;
outbox.start();
await settled();
const beforeDue = polls;
await advance(1_999);
assert.equal(polls, beforeDue, "known deadline adds no polling before it is due");
assert.equal(delivered, 2);
await advance(1);
assert.equal(delivered, 3, "retry wakes at its deadline, before the five-second safety scan");
pendingDue = undefined;
await outbox.stop();
pending = [{ id: "cancel-deadline-on-stop", attempts: 1 }];
pendingDue = now + 2_000;
outbox.start();
await settled();
await outbox.stop();
const afterDue = polls;
await advance(60_000);
assert.equal(polls, afterDue, "stop cancels deadline timers");
pending = [];
pendingDue = undefined;

const appOutbox = appEventOutbox("idle-budget", async () => {});
appOutbox.start();
await settled();
polls = 0;
await advance(60_000);
assert.equal(polls, 12, "app event outbox: at most 12 idle DB claims per minute");
await appOutbox.stop();

const { createWorkflowWorker, notifyWorkflowWorker } = await import("../workflows/store/worker-runtime");
let claims = 0;
let recoveries = 0;
let readyRuns = 0;
let executions = 0;
const workflow = createWorkflowWorker({
  appId: "idle-budget",
  concurrency: 2,
  run: async () => {
    claims++;
    if (readyRuns === 0) return false;
    readyRuns--;
    executions++;
    return true;
  },
  recover: async () => {
    recoveries++;
  },
});
await workflow.start();
await settled();
claims = recoveries = 0;
await advance(60_000);
assert.equal(recoveries, 2, "workflow: at most 2 recovery scans per minute");
assert.equal(claims, 8, "workflow: at most 2 scans x 2 wakes x 2 slots per minute");
readyRuns++;
notifyWorkflowWorker("idle-budget");
await settled();
assert.equal(executions, 1, "committed work wakes immediately without advancing the safety clock");
readyRuns++;
await advance(29_999);
assert.equal(executions, 1, "a deliberately lost hint waits for the recovery scan");
await advance(1);
assert.equal(executions, 2, "a lost hint is repaired within the 30-second safety budget");
await workflow.stop();
const stoppedClaims = claims;
await advance(60_000);
assert.equal(claims, stoppedClaims);

const { startEventDispatcher } = await import("./app-events/runtime");
let brokerPolls = 0;
let maintenance = 0;
const broker = startEventDispatcher(
  {
    work: async ({ reconcile }) => {
      assert.equal(reconcile, false);
      brokerPolls++;
      return 0;
    },
    checkGap: async () => {
      maintenance++;
    },
    retain: async () => {
      maintenance++;
    },
  },
  (error) => {
    throw error;
  },
);
await settled();
brokerPolls = 0;
await advance(60_000);
assert.equal(brokerPolls, 12, "Core dispatcher without registry events: 12 safety scans per minute");
assert.equal(maintenance, 2, "gap and retention run once per minute");
// Bursts cannot advance minute maintenance, or create parallel passes.
for (let i = 0; i < 100; i++) broker.wake();
await settled();
assert.equal(maintenance, 2);
await broker.stop();
assert.equal(timers.size, 0, "every worker releases its timer");
Object.defineProperty(globalThis, "setInterval", { value: realInterval });
Object.defineProperty(globalThis, "clearInterval", { value: realClearInterval });
mock.restore();
setSystemTime();
console.log(
  "Idle minute: outbox 12 claims; workflow 2 recoveries / 8 slot claims; Core without registry events: 12 claims / 1 maintenance pass",
);
