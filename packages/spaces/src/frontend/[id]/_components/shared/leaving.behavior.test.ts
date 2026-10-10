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

  test("shows a dropped row for the delay after its hold, then collapses it, then lets it go", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a", done: true });
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

  test("gives every row its own timer, so ticking another row neither waits nor cuts the first short", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a" });
    leaving.leave("a");
    jest.advanceTimersByTime(400);
    leaving.hold({ id: "b" });
    leaving.leave("b");
    jest.advanceTimersByTime(300);
    expect([leaving.collapsing("a"), leaving.collapsing("b")]).toEqual([true, false]);
    jest.advanceTimersByTime(COLLAPSE_MS);
    expect([...leaving.held().keys()]).toEqual(["b"]);
    jest.advanceTimersByTime(LEAVE_DELAY_MS);
    expect(leaving.held().size).toBe(0);
    dispose();
  });

  test("holding a leaving row again, as Undo does, stops its collapse", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a", done: true });
    leaving.leave("a");
    jest.advanceTimersByTime(LEAVE_DELAY_MS + 50);
    expect(leaving.collapsing("a")).toBe(true);
    leaving.hold({ id: "a", done: false });
    expect(leaving.collapsing("a")).toBe(false);
    jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
    expect(leaving.held().get("a")).toEqual({ id: "a", done: false });
    leaving.release("a");
    expect(leaving.held().size).toBe(0);
    dispose();
  });

  test("stops its timers with its owner", () => {
    jest.useFakeTimers();
    const { leaving, dispose } = leavingRoot();
    leaving.hold({ id: "a" });
    leaving.leave("a");
    dispose();
    jest.advanceTimersByTime(LEAVE_DELAY_MS + COLLAPSE_MS);
    expect(leaving.collapsing("a")).toBe(false);
  });
});
