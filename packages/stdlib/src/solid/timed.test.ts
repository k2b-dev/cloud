import { describe, it, expect, mock } from "bun:test";
import { timed } from "./timed";
import { testRoot } from "../_test-helpers";

const DELAY = 50; // short delay for real-timer tests

// ==========================
// debounce
// ==========================

describe("timed.debounce", () => {
  it("debouncedFn delays callback execution", async () => {
    const callback = mock(() => {});
    const { result: d, dispose } = testRoot(() => timed.debounce(callback, DELAY));

    d.debouncedFn();
    expect(callback).toHaveBeenCalledTimes(0);

    await Bun.sleep(DELAY + 20);
    expect(callback).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("debouncedFn resets timer on subsequent calls", async () => {
    const callback = mock(() => {});
    const { result: d, dispose } = testRoot(() => timed.debounce(callback, DELAY));

    d.debouncedFn();
    await Bun.sleep(DELAY / 2);
    d.debouncedFn(); // reset timer
    await Bun.sleep(DELAY / 2);
    expect(callback).toHaveBeenCalledTimes(0); // not yet -- timer was reset

    await Bun.sleep(DELAY);
    expect(callback).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("trigger executes immediately and cancels pending", async () => {
    const callback = mock((_s: string) => {});
    const { result: d, dispose } = testRoot(() => timed.debounce(callback, DELAY));

    d.debouncedFn("a");
    d.trigger("b");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("b");

    // Original debounced "a" should have been cancelled
    await Bun.sleep(DELAY + 20);
    expect(callback).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("cancel prevents pending execution", async () => {
    const callback = mock(() => {});
    const { result: d, dispose } = testRoot(() => timed.debounce(callback, DELAY));

    d.debouncedFn();
    d.cancel();
    await Bun.sleep(DELAY + 20);
    expect(callback).toHaveBeenCalledTimes(0);
    dispose();
  });

  it("isPending returns true while waiting", async () => {
    const callback = mock(() => {});
    const { result: d, dispose } = testRoot(() => timed.debounce(callback, DELAY));

    expect(d.isPending()).toBe(false);
    d.debouncedFn();
    expect(d.isPending()).toBe(true);
    await Bun.sleep(DELAY + 20);
    expect(d.isPending()).toBe(false);
    dispose();
  });

  it("cleanup on dispose cancels pending timeout", async () => {
    const callback = mock(() => {});
    const { result: d, dispose } = testRoot(() => timed.debounce(callback, DELAY));

    d.debouncedFn();
    dispose();
    await Bun.sleep(DELAY + 20);
    expect(callback).toHaveBeenCalledTimes(0);
  });
});

// ==========================
// interval
// ==========================

describe("timed.interval", () => {
  it("starts immediately by default and executes callback", () => {
    const callback = mock(() => {});
    const { dispose } = testRoot(() => timed.interval(callback, 1000));

    // executeImmediately + autoStart = true by default
    expect(callback).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("repeats at specified interval", async () => {
    const callback = mock(() => {});
    const { dispose } = testRoot(() => timed.interval(callback, DELAY));

    // 1 immediate + at least 2 intervals
    await Bun.sleep(DELAY * 2 + 30);
    expect(callback.mock.calls.length).toBeGreaterThanOrEqual(3);
    dispose();
  });

  it("stop halts interval", async () => {
    const callback = mock(() => {});
    const { result: ctrl, dispose } = testRoot(() => timed.interval(callback, DELAY));

    await Bun.sleep(DELAY + 10);
    ctrl.stop();
    const countAfterStop = callback.mock.calls.length;
    await Bun.sleep(DELAY * 3);
    expect(callback.mock.calls.length).toBe(countAfterStop);
    dispose();
  });

  it("start restarts the interval", () => {
    const callback = mock(() => {});
    const { result: ctrl, dispose } = testRoot(() => timed.interval(callback, 1000));

    ctrl.stop();
    const countAfterStop = callback.mock.calls.length;
    ctrl.start();
    // start() calls executeImmediately
    expect(callback.mock.calls.length).toBe(countAfterStop + 1);
    dispose();
  });

  it("autoStart=false does not start automatically", () => {
    const callback = mock(() => {});
    const { result: ctrl, dispose } = testRoot(() =>
      timed.interval(callback, DELAY, { autoStart: false, executeImmediately: true }),
    );

    expect(callback).toHaveBeenCalledTimes(0);
    expect(ctrl.isRunning()).toBe(false);
    dispose();
  });

  it("executeImmediately=false skips initial execution", async () => {
    const callback = mock(() => {});
    const { dispose } = testRoot(() =>
      timed.interval(callback, DELAY, { autoStart: true, executeImmediately: false }),
    );

    expect(callback).toHaveBeenCalledTimes(0);
    await Bun.sleep(DELAY + 20);
    expect(callback).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("execute runs callback once without affecting interval", () => {
    const callback = mock(() => {});
    const { result: ctrl, dispose } = testRoot(() =>
      timed.interval(callback, 1000, { autoStart: false }),
    );

    ctrl.execute();
    expect(callback).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("isRunning returns correct state", () => {
    const callback = mock(() => {});
    const { result: ctrl, dispose } = testRoot(() => timed.interval(callback, 1000));

    expect(ctrl.isRunning()).toBe(true);
    ctrl.stop();
    expect(ctrl.isRunning()).toBe(false);
    ctrl.start();
    expect(ctrl.isRunning()).toBe(true);
    dispose();
  });

  it("cleanup on dispose stops the interval", async () => {
    const callback = mock(() => {});
    const { dispose } = testRoot(() => timed.interval(callback, DELAY));

    const countBefore = callback.mock.calls.length;
    dispose();
    await Bun.sleep(DELAY * 3);
    expect(callback.mock.calls.length).toBe(countBefore);
  });
});
