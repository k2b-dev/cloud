import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot } from "solid-js";
import { COLLAPSE_MS, createLeavingItems, keepHeld, LEAVE_DELAY_MS } from "./leaving";

type Row = { id: string; done?: boolean };
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (list: Row[]) => list.map((row) => row.id);

describe("keepHeld", () => {
  test("keeps a held row the refresh dropped right after the row it followed", () => {
    const held = new Map([["b", { id: "b", done: true }]]);
    const next = keepHeld(rows("a", "b", "c"), rows("a", "c"), held);
    expect(ids(next)).toEqual(["a", "b", "c"]);
    expect(next[1]).toEqual({ id: "b", done: true });
  });

  test("keeps the first row first, and two held neighbours in their order", () => {
    const held = new Map([
      ["a", { id: "a" }],
      ["b", { id: "b" }],
    ]);
    expect(ids(keepHeld(rows("a", "b", "c"), rows("c"), held))).toEqual(["a", "b", "c"]);
  });

  test("lets a row go that is not held, and does not bring back a held row the view did not show", () => {
    const held = new Map([["x", { id: "x" }]]);
    expect(ids(keepHeld(rows("a", "b", "c"), rows("a", "c"), held))).toEqual(["a", "c"]);
  });

  test("anchors behind the closest row before it that the refresh kept", () => {
    const held = new Map([["c", { id: "c" }]]);
    expect(ids(keepHeld(rows("a", "b", "c", "d"), rows("a", "d", "e"), held))).toEqual(["a", "c", "d", "e"]);
  });

  test("uses the refreshed row while the refresh still has it", () => {
    const held = new Map([["a", { id: "a", done: true }]]);
    expect(keepHeld(rows("a"), [{ id: "a", done: false }], held)).toEqual([{ id: "a", done: false }]);
  });
});

describe("createLeavingItems", () => {
  afterEach(() => jest.useRealTimers());

  const leavingRoot = () => createRoot((dispose) => ({ leaving: createLeavingItems<Row>(), dispose }));

  test("shows a dropped row as held for the delay after the tick, then collapses it, then lets it go", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a" }, true);
    expect(leaving.completed("a")).toBe(true);
    expect(leaving.completed("b")).toBeUndefined();
    // The server and the refresh take a while; the delay counts from the tick.
    jest.advanceTimersByTime(300);
    leaving.leave("a");
    jest.advanceTimersByTime(LEAVE_DELAY_MS - 300 - 1);
    expect(leaving.collapsing("a")).toBe(false);
    jest.advanceTimersByTime(1);
    expect(leaving.collapsing("a")).toBe(true);
    expect(leaving.held().has("a")).toBe(true);
    jest.advanceTimersByTime(COLLAPSE_MS);
    expect(leaving.held().has("a")).toBe(false);
    dispose();
  });

  test("lets the rows wait while the reader keeps ticking, then collapses them together", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a" }, true);
    leaving.leave("a");
    jest.advanceTimersByTime(400);
    leaving.hold({ id: "b" }, true);
    leaving.leave("b");
    // The first row would be due now, but the reader just ticked the next one: nothing moves under the pointer.
    jest.advanceTimersByTime(LEAVE_DELAY_MS - 1);
    expect([leaving.collapsing("a"), leaving.collapsing("b")]).toEqual([false, false]);
    jest.advanceTimersByTime(1);
    expect([leaving.collapsing("a"), leaving.collapsing("b")]).toEqual([true, true]);
    jest.advanceTimersByTime(COLLAPSE_MS);
    expect(leaving.held().size).toBe(0);
    dispose();
  });

  test("lets the rows wait while the pointer moves over the view", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a" }, true);
    leaving.leave("a");
    jest.advanceTimersByTime(600);
    leaving.postpone();
    jest.advanceTimersByTime(600);
    leaving.postpone();
    jest.advanceTimersByTime(LEAVE_DELAY_MS - 1);
    expect(leaving.collapsing("a")).toBe(false);
    jest.advanceTimersByTime(1);
    expect(leaving.collapsing("a")).toBe(true);
    dispose();
  });

  test("offers the Undo of a held row until it is held again, and holding a leaving row again stops its collapse", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    const undo = () => {};
    leaving.hold({ id: "a" }, true);
    leaving.leave("a");
    leaving.offerUndo("a", undo);
    expect(leaving.undo("a")).toBe(undo);
    jest.advanceTimersByTime(LEAVE_DELAY_MS + 50);
    expect(leaving.collapsing("a")).toBe(true);
    leaving.hold({ id: "a", done: false }, false);
    expect(leaving.collapsing("a")).toBe(false);
    expect(leaving.undo("a")).toBeUndefined();
    expect(leaving.completed("a")).toBe(false);
    jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
    expect(leaving.held().get("a")).toEqual({ id: "a", done: false });
    leaving.release("a");
    expect(leaving.held().size).toBe(0);
    // An item that is not held offers nothing.
    leaving.offerUndo("a", undo);
    expect(leaving.undo("a")).toBeUndefined();
    dispose();
  });

  test("stops its timers with its owner", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a" }, true);
    leaving.leave("a");
    dispose();
    jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
    expect(leaving.collapsing("a")).toBe(false);
  });
});
