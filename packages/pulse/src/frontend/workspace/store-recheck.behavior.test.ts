import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { PulseStoreOutage } from "../../contracts";
import { installStoreRecheck, STORE_RECHECK_MS } from "./store-recheck";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("installStoreRecheck", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  afterEach(() => jest.useRealTimers());

  const setup = (initial: PulseStoreOutage) => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    let hidden = false;
    Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => hidden });
    const answers: PulseStoreOutage[] = [];
    const calls = { check: 0, recovered: 0 };
    const root = createRoot((dispose) => {
      const [view, setView] = createSignal("sources");
      const store = installStoreRecheck({
        initial,
        failedSince: () => false,
        watching: () => view() === "sources",
        check: async () => {
          calls.check++;
          return answers.shift() ?? { unavailable: true, since: initial.since };
        },
        recovered: async () => {
          calls.recovered++;
        },
      });
      return { dispose, setView, store };
    });
    const tick = async () => {
      jest.advanceTimersByTime(STORE_RECHECK_MS);
      await flush();
    };
    const setHidden = (value: boolean) => {
      hidden = value;
      dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    };
    const done = () => {
      root.dispose();
      dom.cleanup();
    };
    return { root, answers, calls, tick, setHidden, done };
  };

  test("a store that is fine asks nothing", async () => {
    const run = setup({ unavailable: false, since: null });
    for (let i = 0; i < 3; i++) await run.tick();
    expect(run.calls.check).toBe(0);
    expect(run.root.store.down()).toBe(false);
    run.done();
  });

  test("a lost store is read again every 30 s on Sources, and the down state ends in place once it answers", async () => {
    const run = setup({ unavailable: true, since: "2026-11-22T09:40:00.000Z" });
    jest.advanceTimersByTime(STORE_RECHECK_MS - 1);
    await flush();
    expect(run.calls.check).toBe(0);
    await run.tick();
    expect(run.calls.check).toBe(1);
    expect(run.root.store.down()).toBe(true);
    expect(run.root.store.since()).toBe("2026-11-22T09:40:00.000Z");

    run.answers.push({ unavailable: false, since: null });
    await run.tick();
    expect(run.calls.check).toBe(2);
    expect(run.root.store.down()).toBe(false);
    expect(run.root.store.since()).toBeNull();
    expect(run.calls.recovered).toBe(1);
    // Fine again: no further request.
    for (let i = 0; i < 3; i++) await run.tick();
    expect(run.calls.check).toBe(2);
    run.done();
  });

  test("a hidden document and another tab stop the check; it starts again where the store is still down", async () => {
    const run = setup({ unavailable: true, since: null });
    run.setHidden(true);
    for (let i = 0; i < 3; i++) await run.tick();
    expect(run.calls.check).toBe(0);
    run.setHidden(false);
    await run.tick();
    expect(run.calls.check).toBe(1);

    run.root.setView("usage");
    for (let i = 0; i < 3; i++) await run.tick();
    expect(run.calls.check).toBe(1);
    run.root.setView("sources");
    await run.tick();
    expect(run.calls.check).toBe(2);
    expect(run.calls.recovered).toBe(0);
    run.done();
  });
});
