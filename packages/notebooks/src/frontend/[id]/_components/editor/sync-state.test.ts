import { expect, setSystemTime, test } from "bun:test";
import type { SyncStateEventDetail } from "../detail/events";
import { CONNECT_SETTLE_MS, createSyncStateBridge } from "./sync-state";

test("sync snapshots debounce offline, confirm drained saves, answer late panels and clean up", () => {
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const delays: number[] = [];
  Object.assign(globalThis, {
    setTimeout: (fn: () => void, delay: number) => {
      delays.push(delay);
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const states: SyncStateEventDetail[] = [];
  let unsent = false;
  setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
  const bridge = createSyncStateBridge({ hasUnsentChanges: () => unsent, emit: (state) => states.push(state) });
  // A note connects with its first edit; until then it waits with no timer.
  expect(delays).toEqual([]);
  bridge.start();
  try {
    expect(delays).toEqual([CONNECT_SETTLE_MS]);
    expect(states).toEqual([]);
    bridge.request();
    expect(states.at(-1)).toEqual({ connected: true, lastSavedAt: null, ended: false });
    bridge.connectionChanged(true);
    expect(timers.size).toBe(0);
    expect(states.at(-1)?.lastSavedAt).toBeNull();
    bridge.ready();
    expect(states.at(-1)).toEqual({ connected: true, lastSavedAt: "2026-10-01T10:00:00.000Z", ended: false });
    unsent = true;
    setSystemTime(new Date("2026-10-01T10:01:00.000Z"));
    bridge.unsentChanged();
    expect(states.at(-1)?.lastSavedAt).toBe("2026-10-01T10:00:00.000Z");
    unsent = false;
    bridge.unsentChanged();
    expect(states.at(-1)?.lastSavedAt).toBe("2026-10-01T10:01:00.000Z");
    bridge.connectionChanged(false);
    expect(delays.at(-1)).toBe(1_000);
    expect(states.at(-1)?.connected).toBe(true);
    bridge.connectionChanged(true); // transient drop never reports offline
    expect(timers.size).toBe(0);
    bridge.connectionChanged(false);
    timers.get(nextTimer)!();
    timers.delete(nextTimer);
    expect(states.at(-1)?.connected).toBe(false);
    setSystemTime(new Date("2026-10-01T10:02:00.000Z"));
    bridge.unsentChanged();
    bridge.request();
    expect(states.at(-1)).toEqual({ connected: false, lastSavedAt: "2026-10-01T10:01:00.000Z", ended: false });
    // An ended session says so, so the panel does not promise a resend; reconnecting clears it.
    bridge.end();
    expect(states.at(-1)?.ended).toBe(true);
    bridge.connectionChanged(true);
    expect(states.at(-1)).toEqual({ connected: true, lastSavedAt: "2026-10-01T10:01:00.000Z", ended: false });
    bridge.connectionChanged(false);
    bridge.dispose();
    expect(timers.size).toBe(0);
  } finally {
    bridge.dispose();
    Object.assign(globalThis, { setTimeout: originalTimeout, clearTimeout: originalClear });
    setSystemTime();
  }
});

test("first connections get the full connect grace and connecting within it never reports offline", () => {
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let nextTimer = 0;
  Object.assign(globalThis, {
    setTimeout: (callback: () => void, delay: number) => {
      timers.set(++nextTimer, { at: now + delay, callback });
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  const states: SyncStateEventDetail[] = [];
  const options = { hasUnsentChanges: () => false, emit: (state: SyncStateEventDetail) => states.push(state) };
  const bridge = createSyncStateBridge(options);
  // A note connects with its first edit; until then it waits with no timer.
  expect(timers.size).toBe(0);
  bridge.start();
  try {
    advance(CONNECT_SETTLE_MS - 1);
    expect(states).toEqual([]);
    advance(1);
    expect(states).toEqual([{ connected: false, lastSavedAt: null, ended: false }]);
    bridge.dispose();
    states.length = 0;
    const slow = createSyncStateBridge(options);
    try {
      advance(CONNECT_SETTLE_MS - 1);
      slow.connectionChanged(true);
      advance(CONNECT_SETTLE_MS);
      expect(states).toEqual([{ connected: true, lastSavedAt: null, ended: false }]);
      slow.connectionChanged(false);
      advance(999);
      expect(states.at(-1)?.connected).toBe(true);
      advance(1);
      expect(states.at(-1)?.connected).toBe(false);
    } finally {
      slow.dispose();
    }
  } finally {
    bridge.dispose();
    Object.assign(globalThis, { setTimeout: originalTimeout, clearTimeout: originalClear });
  }
});
