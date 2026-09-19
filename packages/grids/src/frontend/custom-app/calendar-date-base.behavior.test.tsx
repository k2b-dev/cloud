import { expect, setSystemTime, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { createCalendarDateBase } from "./calendar-date-base";

const domTest = isServer ? test.skip : test;

domTest("calendar clock updates only on a local day change and releases its timer", () => {
  const dom = createDomTestHarness();
  const initial = "2026-03-28T22:59:00Z";
  setSystemTime(new Date(initial));
  const interval = spyOn(globalThis, "setInterval");
  const tick = () => {
    const callback = interval.mock.calls[0]?.[0];
    if (typeof callback === "function") callback();
  };
  const clear = spyOn(globalThis, "clearInterval");
  let read: (() => string) | undefined;
  const dispose = render(() => {
    read = createCalendarDateBase(initial, "Europe/Berlin");
    return <span>{read()}</span>;
  }, dom.root);
  try {
    expect(interval).toHaveBeenCalledTimes(1);
    setSystemTime(new Date("2026-03-28T22:59:59Z"));
    tick?.();
    expect(read?.()).toBe(initial);
    setSystemTime(new Date("2026-03-28T23:00:00Z"));
    tick?.();
    expect(read?.()).toBe("2026-03-28T23:00:00.000Z");
    dispose();
    expect(clear).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
    interval.mockRestore();
    clear.mockRestore();
    setSystemTime();
    dom.cleanup();
  }
});
