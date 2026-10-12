import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDomTestHarness, type DomTestHarness } from "../../test/dom";
import {
  calendarAutoScrollSpeed,
  calendarDayIndexAtPoint,
  calendarMinuteAtPoint,
  snapCalendarMinutes,
  startCalendarPointerSession,
} from "./calendar-pointer";

describe("calendar pointer geometry", () => {
  test("snaps to quarter-hour boundaries", () => {
    expect(snapCalendarMinutes(607)).toBe(600);
    expect(snapCalendarMinutes(608)).toBe(615);
  });

  test("maps horizontal points to bounded day columns", () => {
    expect(calendarDayIndexAtPoint(100, 100, 700, 7)).toBe(0);
    expect(calendarDayIndexAtPoint(799, 100, 700, 7)).toBe(6);
    expect(calendarDayIndexAtPoint(800, 100, 700, 7)).toBeNull();
  });

  test("maps vertical points to visible snapped minutes", () => {
    expect(calendarMinuteAtPoint(100, 100, 600, 8, 17)).toBe(480);
    expect(calendarMinuteAtPoint(250, 100, 600, 8, 17)).toBe(630);
    expect(calendarMinuteAtPoint(700, 100, 600, 8, 17)).toBe(1080);
  });

  test("scrolls only near viewport edges", () => {
    expect(calendarAutoScrollSpeed(120, 100, 600)).toBeLessThan(0);
    expect(calendarAutoScrollSpeed(350, 100, 600)).toBe(0);
    expect(calendarAutoScrollSpeed(590, 100, 600)).toBeGreaterThan(0);
  });
});

describe("calendar pointer session endings", () => {
  let dom: DomTestHarness;
  let cancel: (() => void) | undefined;
  beforeEach(() => {
    dom = createDomTestHarness();
  });
  afterEach(() => {
    cancel?.();
    cancel = undefined;
    dom.cleanup();
  });
  const pointer = (type: string, clientX = 0) =>
    new dom.window.PointerEvent(type, { pointerId: 7, isPrimary: true, button: 0, clientX }) as unknown as PointerEvent;

  test("an inactive release ends once without committing or cancelling", () => {
    const calls: string[] = [];
    cancel = startCalendarPointerSession({
      event: pointer("pointerdown"),
      resolve: () => 1,
      onPreview: () => {},
      onCommit: () => calls.push("commit"),
      onCancel: () => calls.push("cancel"),
      onEnd: () => calls.push("end"),
    });
    window.dispatchEvent(pointer("pointerup"));
    window.dispatchEvent(pointer("pointercancel"));
    cancel();
    expect(calls).toEqual(["end"]);
  });

  for (const active of [false, true]) {
    test.each(["pointercancel", "blur", "Escape", "cancel", "replacement"])(
      `an ${active ? "active" : "inactive"} session ends once on %s`,
      (reason) => {
        const calls: string[] = [];
        cancel = startCalendarPointerSession({
          event: pointer("pointerdown"),
          resolve: () => 1,
          onPreview: () => {},
          onCommit: () => calls.push("commit"),
          onCancel: () => calls.push("cancel"),
          onEnd: () => calls.push("end"),
        });
        if (active) window.dispatchEvent(pointer("pointermove", 10));
        if (reason === "pointercancel") window.dispatchEvent(pointer("pointercancel"));
        else if (reason === "blur") window.dispatchEvent(new Event("blur"));
        else if (reason === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        else if (reason === "cancel") cancel();
        else {
          const previous = cancel;
          cancel = startCalendarPointerSession({
            event: pointer("pointerdown"),
            resolve: () => null,
            onPreview: () => {},
            onCommit: () => {},
          });
          previous();
        }
        window.dispatchEvent(pointer("pointerup"));
        cancel();
        expect(calls).toEqual(active ? ["cancel", "end"] : ["end"]);
      },
    );
  }

  test("a commit runs before the session ends", () => {
    const calls: string[] = [];
    cancel = startCalendarPointerSession({
      event: pointer("pointerdown"),
      resolve: () => 1,
      onPreview: () => {},
      onCommit: () => calls.push("commit"),
      onCancel: () => calls.push("cancel"),
      onEnd: () => calls.push("end"),
    });
    window.dispatchEvent(pointer("pointermove", 10));
    window.dispatchEvent(pointer("pointerup"));
    cancel();
    expect(calls).toEqual(["commit", "end"]);
  });
});
