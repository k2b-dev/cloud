import { expect, setSystemTime, test } from "bun:test";
import type { SyncStateEventDetail } from "../detail/events";
import { createSyncStateBridge } from "./sync-state";

test("sync snapshots debounce offline, confirm drained saves, answer late panels and clean up", () => {
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  Object.assign(globalThis, {
    setTimeout: (fn: () => void, delay: number) => {
      expect(delay).toBe(1_000);
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const states: SyncStateEventDetail[] = [];
  let unsent = false;
  setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
  const bridge = createSyncStateBridge({ hasUnsentChanges: () => unsent, emit: (state) => states.push(state) });
  try {
    expect(states).toEqual([]);
    bridge.request();
    expect(states.at(-1)).toEqual({ connected: true, lastSavedAt: null });
    bridge.connectionChanged(true);
    expect(timers.size).toBe(0);
    expect(states.at(-1)?.lastSavedAt).toBeNull();
    bridge.ready();
    expect(states.at(-1)).toEqual({ connected: true, lastSavedAt: "2026-10-01T10:00:00.000Z" });
    unsent = true;
    setSystemTime(new Date("2026-10-01T10:01:00.000Z"));
    bridge.unsentChanged();
    expect(states.at(-1)?.lastSavedAt).toBe("2026-10-01T10:00:00.000Z");
    unsent = false;
    bridge.unsentChanged();
    expect(states.at(-1)?.lastSavedAt).toBe("2026-10-01T10:01:00.000Z");
    bridge.connectionChanged(false);
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
    expect(states.at(-1)).toEqual({ connected: false, lastSavedAt: "2026-10-01T10:01:00.000Z" });
    bridge.connectionChanged(false);
    bridge.dispose();
    expect(timers.size).toBe(0);
  } finally {
    bridge.dispose();
    Object.assign(globalThis, { setTimeout: originalTimeout, clearTimeout: originalClear });
    setSystemTime();
  }
});
