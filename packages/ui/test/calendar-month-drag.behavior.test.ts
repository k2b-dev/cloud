import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { CalendarEvent, CalendarEventTimeChange } from "../src/content/Calendar";
import { createDomTestHarness, type DomTestHarness } from "./dom";

/** happy-dom has no popover API; the quick create only needs open state and focus. */
const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const open = new WeakSet<Element>();
  const matches = prototype.matches;
  const patch = (key: PropertyKey, value: unknown) => Object.defineProperty(prototype, key, { configurable: true, writable: true, value });
  patch("matches", function (this: Element, selector: string) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  });
  patch("showPopover", function (this: HTMLElement) {
    open.add(this);
  });
  patch("hidePopover", function (this: HTMLElement) {
    open.delete(this);
  });
};

const key = (date: Date) => date.toISOString().slice(0, 10);
const range = (value: CalendarEventTimeChange | null) =>
  value ? { start: key(value.start), end: key(value.end), allDay: value.allDay } : null;

describe("@k2b/ui Calendar month selection and bars", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a click selects a day instead of navigating; the keys move and extend the selection, and Enter creates on it", async () => {
    const dom = createDomTestHarness();
    const { default: Calendar } = await import("../src/content/Calendar");
    // Solid delegates to the document its module first ran in; each test has a document of its own.
    delegateEvents(["click", "dblclick", "keydown", "pointerdown"], dom.document);
    const selections: Array<ReturnType<typeof range>> = [];
    const slots: Array<ReturnType<typeof range>> = [];
    const dispose = render(
      () =>
        createComponent(Calendar, {
          date: "2026-08-12T12:00:00Z",
          view: "month",
          timeZone: "UTC",
          events: [],
          getDateHref: (date, view) => `/calendar?view=${view}&date=${key(date)}`,
          onSelectionChange: (value) => selections.push(range(value)),
          onSlotActivate: (slot) => slots.push(range(slot)),
        }),
      dom.root,
    );
    const cell = (day: string) => dom.root.querySelector<HTMLElement>(`[data-calendar-day-key="${day}"]`)!;
    const selected = () =>
      Array.from(dom.root.querySelectorAll<HTMLElement>("[aria-selected='true']"), (element) => element.dataset.calendarDayKey);
    const press = (target: HTMLElement, keyName: string, shiftKey = false) =>
      target.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: keyName, shiftKey, bubbles: true, cancelable: true }) as unknown as Event,
      );

    // Neither the cell nor its number is a link: a click only selects the day.
    expect(cell("2026-08-12").closest("a")).toBeNull();
    expect(cell("2026-08-12").querySelector("a")).toBeNull();
    cell("2026-08-12").click();
    expect(selected()).toEqual(["2026-08-12"]);
    expect(dom.window.location.href).toBe("http://localhost/");

    press(cell("2026-08-12"), "ArrowRight");
    expect(selected()).toEqual(["2026-08-13"]);
    press(cell("2026-08-13"), "ArrowDown", true);
    expect(selected()).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);
    press(cell("2026-08-20"), "Enter");
    expect(slots).toEqual([{ start: "2026-08-13", end: "2026-08-21", allDay: true }]);
    expect(selections.at(-1)).toEqual({ start: "2026-08-13", end: "2026-08-21", allDay: true });
    // A double-click creates on the day it lands on.
    cell("2026-08-03").dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true }) as unknown as Event);
    expect(slots.at(-1)).toEqual({ start: "2026-08-03", end: "2026-08-04", allDay: true });
    // Escape clears the selection.
    press(cell("2026-08-03"), "Escape");
    expect(selected()).toEqual([]);
    expect(selections.at(-1)).toBeNull();

    dispose();
    dom.cleanup();
  });

  test("the quick create opens quietly after a click, takes the focus on Enter, and the menu creates through it", async () => {
    const dom = createDomTestHarness();
    const { default: Calendar } = await import("../src/content/Calendar");
    delegateEvents(["click", "dblclick", "keydown", "pointerdown", "focusin"], dom.document);
    installPopoverApi(dom);
    const opened: Array<{ range: ReturnType<typeof range>; create?: string }> = [];
    let menuControls: { quickCreate: (create?: string) => void } | undefined;
    const dispose = render(
      () =>
        createComponent(Calendar, {
          date: "2026-08-12T12:00:00Z",
          view: "month",
          timeZone: "UTC",
          events: [],
          getDateHref: (date, view) => `/calendar?view=${view}&date=${key(date)}`,
          selectionMenu: (_range, controls) => {
            menuControls = controls;
            return [{ label: "New event", action: () => controls.quickCreate("event") }];
          },
          renderQuickCreate: (value, controls) => {
            opened.push({ range: range(value), create: controls.create });
            return createComponent(() => {
              const input = dom.document.createElement("input");
              input.setAttribute("aria-label", "Title");
              return input;
            }, {});
          },
        }),
      dom.root,
    );
    const cell = (day: string) => dom.root.querySelector<HTMLElement>(`[data-calendar-day-key="${day}"]`)!;
    const popover = () => dom.document.querySelector<HTMLElement>(".k2b-calendar-popover");
    const press = (target: HTMLElement, keyName: string) =>
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }) as unknown as Event);
    const settle = () => new Promise((done) => setTimeout(done, 0));

    // A mouse click selects the day and shows the quick create beside it without moving the focus.
    cell("2026-08-12").dispatchEvent(
      new dom.window.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event,
    );
    cell("2026-08-12").click();
    await settle();
    expect(opened.at(-1)).toEqual({ range: { start: "2026-08-12", end: "2026-08-13", allDay: true }, create: undefined });
    expect(popover()?.dataset.kind).toBe("create");
    expect(popover()?.dataset.quiet).toBe("true");
    expect(dom.document.activeElement).toBe(cell("2026-08-12"));

    // The arrows move the quiet quick create along with the selection.
    press(cell("2026-08-12"), "ArrowRight");
    await settle();
    expect(opened.at(-1)?.range).toEqual({ start: "2026-08-13", end: "2026-08-14", allDay: true });

    // Escape closes it; Enter opens it again with the focus in its field.
    press(cell("2026-08-13"), "Escape");
    expect(popover()?.dataset.kind).toBeUndefined();
    press(cell("2026-08-13"), "Enter");
    await settle();
    expect(popover()?.dataset.quiet).toBeUndefined();
    expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Title");

    // The application's menu entries open the quick create with what they name.
    menuControls?.quickCreate("task");
    await settle();
    expect(opened.at(-1)).toEqual({ range: { start: "2026-08-13", end: "2026-08-14", allDay: true }, create: "task" });

    dispose();
    dom.cleanup();
  });

  test("a long event is one bar per week row, and moving it shifts it by the days the pointer moved", async () => {
    const dom = createDomTestHarness();
    const { default: Calendar } = await import("../src/content/Calendar");
    // Solid delegates to the document its module first ran in; each test has a document of its own.
    delegateEvents(["click", "dblclick", "keydown", "pointerdown"], dom.document);
    const drops: Array<{ id: string; next: ReturnType<typeof range> }> = [];
    const events: CalendarEvent[] = [{ id: "fair", title: "Fair setup", start: "2026-08-05", end: "2026-08-12", allDay: true }];
    const dispose = render(
      () =>
        createComponent(Calendar, {
          date: "2026-08-12T12:00:00Z",
          view: "month",
          timeZone: "UTC",
          events,
          onEventDrop: (event, next) => drops.push({ id: event.id, next: range(next) }),
        }),
      dom.root,
    );
    const bars = Array.from(dom.root.querySelectorAll<HTMLElement>("[data-calendar-event]"));
    expect(
      bars.map((bar) => ({
        day: bar.closest<HTMLElement>("[data-calendar-day-key]")?.dataset.calendarDayKey,
        span: bar.parentElement?.style.getPropertyValue("--k2b-calendar-span"),
        label: bar.getAttribute("aria-label"),
        before: bar.dataset.continuesBefore,
        after: bar.dataset.continuesAfter,
      })),
    ).toEqual([
      { day: "2026-08-05", span: "5", label: "Fair setup, August 5 to August 11", before: undefined, after: "true" },
      { day: "2026-08-10", span: "2", label: "Fair setup, August 5 to August 11", before: "true", after: undefined },
    ]);

    // Cells get boxes by their place in the grid: 100 px wide, 80 px tall.
    const cells = Array.from(dom.root.querySelectorAll<HTMLElement>("[data-calendar-day-key]"));
    cells.forEach((cell, index) => {
      const left = (index % 7) * 100;
      const top = Math.floor(index / 7) * 80;
      cell.getBoundingClientRect = () => ({
        left,
        top,
        right: left + 100,
        bottom: top + 80,
        width: 100,
        height: 80,
        x: left,
        y: top,
        toJSON: () => ({}),
      });
    });
    const pointer = (type: string, x: number, y: number) =>
      new dom.window.PointerEvent(type, {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: y,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse",
      });
    // Grabbed on its second row, on Tuesday the 11th, and dropped on Thursday the 13th: two days later.
    bars[1]!.dispatchEvent(pointer("pointerdown", 150, 190) as unknown as Event);
    dom.window.dispatchEvent(pointer("pointermove", 250, 190));
    dom.window.dispatchEvent(pointer("pointermove", 350, 190));
    const previewed = Array.from(
      dom.root.querySelectorAll<HTMLElement>("[data-drop-preview='true']"),
      (cell) => cell.dataset.calendarDayKey,
    );
    expect(previewed).toEqual(["2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13"]);
    dom.window.dispatchEvent(pointer("pointerup", 350, 190));
    expect(drops).toEqual([{ id: "fair", next: { start: "2026-08-07", end: "2026-08-14", allDay: true } }]);

    dispose();
    dom.cleanup();
  });
});
