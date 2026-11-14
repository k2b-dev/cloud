import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createDelayedLoading } from "./Skeleton";

// Short real timers with wide margins: the helper only schedules timeouts and reads `performance.now()`.
const DELAY = 40;
const MINIMUM = 120;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const setup = () =>
  createRoot((dispose) => {
    const [pending, setPending] = createSignal(false);
    const shown = createDelayedLoading(pending, { delay: DELAY, minimum: MINIMUM });
    return { shown, setPending, dispose };
  });

describe("createDelayedLoading", () => {
  test("a fast answer never shows the loading state", async () => {
    const { shown, setPending, dispose } = setup();
    setPending(true);
    await wait(DELAY / 4);
    expect(shown()).toBe(false);
    setPending(false);
    await wait(DELAY * 2);
    expect(shown()).toBe(false);
    dispose();
  });

  test("a slow answer shows it after the delay and keeps it for the minimum", async () => {
    const { shown, setPending, dispose } = setup();
    setPending(true);
    expect(shown()).toBe(false);
    await wait(DELAY + 30);
    expect(shown()).toBe(true);
    setPending(false);
    // The answer arrived right after the state appeared: it stays until the minimum has passed.
    await wait(MINIMUM / 3);
    expect(shown()).toBe(true);
    await wait(MINIMUM);
    expect(shown()).toBe(false);
    dispose();
  });

  test("pending again during the minimum keeps one continuous loading state", async () => {
    const { shown, setPending, dispose } = setup();
    setPending(true);
    await wait(DELAY + 30);
    setPending(false);
    await wait(10);
    setPending(true);
    await wait(MINIMUM + 40);
    expect(shown()).toBe(true);
    setPending(false);
    await wait(10);
    expect(shown()).toBe(false);
    dispose();
  });

  test("disposing clears a scheduled change", async () => {
    const { shown, setPending, dispose } = setup();
    setPending(true);
    dispose();
    await wait(DELAY + 30);
    expect(shown()).toBe(false);
  });
});
