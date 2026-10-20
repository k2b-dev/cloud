import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { installPeriodicRefresh } from "./periodic-refresh";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("installPeriodicRefresh", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  afterEach(() => jest.useRealTimers());

  test("runs one refresh at a time while slow lookups update what `active` reads", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    let running = 0;
    let peak = 0;
    let calls = 0;
    const pending: Array<() => void> = [];
    const root = createRoot((dispose) => {
      // Like the admin rows: every lookup replaces a row, which `active` reads.
      const [rows, setRows] = createSignal([{ state: "running" }, { state: "running" }]);
      const [enabled, setEnabled] = createSignal(true);
      installPeriodicRefresh({
        active: () => enabled() && rows().some((row) => row.state === "running"),
        refresh: async () => {
          calls++;
          running++;
          peak = Math.max(peak, running);
          for (let i = 0; i < 2; i++) {
            await new Promise<void>((resolve) => pending.push(resolve));
            setRows((current) => current.map((row) => ({ ...row })));
          }
          running--;
        },
      });
      return { dispose, setEnabled };
    });

    jest.advanceTimersByTime(5_000);
    await flush();
    expect(calls).toBe(1);
    // The first lookup answers and updates a row; the second one takes longer than several intervals.
    pending.shift()?.();
    await flush();
    for (let tick = 0; tick < 3; tick++) {
      jest.advanceTimersByTime(5_000);
      await flush();
    }
    expect(calls).toBe(1);
    expect(peak).toBe(1);

    // Switching off and on while a refresh still waits does not start a second one either.
    root.setEnabled(false);
    root.setEnabled(true);
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(peak).toBe(1);

    expect(calls).toBe(1);
    pending.shift()?.();
    await flush();
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(calls).toBe(2);
    expect(peak).toBe(1);
    root.dispose();
    pending.forEach((resolve) => resolve());
    dom.cleanup();
  });

  test("a failed refresh stays visible until one succeeds, and retry asks again at once", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    let calls = 0;
    let fail = true;
    const root = createRoot((dispose) => {
      const [enabled, setEnabled] = createSignal(true);
      const followed = installPeriodicRefresh({
        active: enabled,
        refresh: async () => {
          calls++;
          if (fail) throw new Error("lookup failed");
        },
      });
      return { dispose, setEnabled, followed };
    });

    jest.advanceTimersByTime(5_000);
    await flush();
    expect(calls).toBe(1);
    expect(root.followed.failed()).toBe(true);
    // Retry does not wait for the backoff.
    fail = false;
    root.followed.retry();
    jest.advanceTimersByTime(0);
    await flush();
    expect(calls).toBe(2);
    expect(root.followed.failed()).toBe(false);

    // A failure ends with the work it followed.
    fail = true;
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(root.followed.failed()).toBe(true);
    root.setEnabled(false);
    expect(root.followed.failed()).toBe(false);
    root.dispose();
    dom.cleanup();
  });
});
