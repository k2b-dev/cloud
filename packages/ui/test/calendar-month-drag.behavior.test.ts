import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
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

  test("Page Up, Page Down, and the header page to the same day of the month, or to its last day when it is shorter", async () => {
    const dom = createDomTestHarness();
    const { default: Calendar } = await import("../src/content/Calendar");
    delegateEvents(["click", "keydown"], dom.document);
    const [date, setDate] = createSignal<Date | string>("2026-01-15T12:00:00Z");
    const changes: string[] = [];
    const dispose = render(
      () =>
        createComponent(Calendar, {
          get date() {
            return date();
          },
          view: "month",
          timeZone: "UTC",
          events: [],
          onDateChange: (next) => {
            changes.push(key(next));
            setDate(next);
          },
        }),
      dom.root,
    );
    const cell = (day: string) => dom.root.querySelector<HTMLElement>(`[data-calendar-day-key="${day}"]`)!;
    const selected = () =>
      Array.from(dom.root.querySelectorAll<HTMLElement>("[aria-selected='true']"), (element) => element.dataset.calendarDayKey);
    const page = async (day: string, keyName: "PageUp" | "PageDown") => {
      cell(day).click();
      cell(day).dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }) as unknown as Event,
      );
      await new Promise((done) => setTimeout(done, 0));
      return { shown: changes.at(-1), selected: selected() };
    };

    // January 31 has no February twin: February 28 it is, not March 3.
    expect(await page("2026-01-31", "PageDown")).toEqual({ shown: "2026-02-28", selected: ["2026-02-28"] });
    setDate("2026-03-15T12:00:00Z");
    expect(await page("2026-03-31", "PageUp")).toEqual({ shown: "2026-02-28", selected: ["2026-02-28"] });
    setDate("2026-10-15T12:00:00Z");
    expect(await page("2026-10-31", "PageUp")).toEqual({ shown: "2026-09-30", selected: ["2026-09-30"] });
    setDate("2026-10-15T12:00:00Z");
    expect(await page("2026-10-31", "PageDown")).toEqual({ shown: "2026-11-30", selected: ["2026-11-30"] });

    // The header's previous and next step the same way from the last day of a month.
    setDate("2026-03-31T12:00:00Z");
    dom.root.querySelector<HTMLElement>("button[aria-label='Previous']")!.click();
    expect(changes.at(-1)).toBe("2026-02-28");
    setDate("2026-01-31T12:00:00Z");
    dom.root.querySelector<HTMLElement>("button[aria-label='Next']")!.click();
    expect(changes.at(-1)).toBe("2026-02-28");

    dispose();
    dom.cleanup();
  });

  test("another view drops the selection and says so, and a host's own view switch opens at the selected day", async () => {
    const dom = createDomTestHarness();
    const { default: Calendar } = await import("../src/content/Calendar");
    delegateEvents(["click"], dom.document);
    const [date, setDate] = createSignal<Date | string>("2026-08-12T12:00:00Z");
    const [view, setView] = createSignal<"day" | "week" | "month">("month");
    const selections: Array<ReturnType<typeof range>> = [];
    const opened: string[] = [];
    const dispose = render(
      () =>
        createComponent(Calendar, {
          get date() {
            return date();
          },
          get view() {
            return view();
          },
          views: ["day", "week", "month"],
          timeZone: "UTC",
          events: [],
          onSelectionChange: (value) => selections.push(range(value)),
          onViewChange: (next) => {
            opened.push(`view ${next}`);
            setView(next as "day" | "week" | "month");
          },
          onDateChange: (next, nextView) => {
            opened.push(`date ${key(next)} ${nextView}`);
            setDate(next);
          },
        }),
      dom.root,
    );
    const cell = (day: string) => dom.root.querySelector<HTMLElement>(`[data-calendar-day-key="${day}"]`)!;
    const option = (label: string) =>
      Array.from(dom.root.querySelectorAll<HTMLElement>("[role='radio']")).find((element) => element.textContent === label)!;

    cell("2026-08-20").click();
    expect(selections.at(-1)).toEqual({ start: "2026-08-20", end: "2026-08-21", allDay: true });
    option("Day").click();
    expect(opened).toEqual(["view day", "date 2026-08-20 day"]);
    expect(view()).toBe("day");
    expect(key(new Date(date()))).toBe("2026-08-20");
    // The month view went with its selection, so actions outside the grid no longer create on August 20.
    expect(selections.at(-1)).toBeNull();

    // Back in the month view nothing is selected, and the switcher keeps the shown day.
    option("Month").click();
    expect(dom.root.querySelectorAll("[aria-selected='true']")).toHaveLength(0);
    expect(selections.at(-1)).toBeNull();
    opened.length = 0;
    option("Week").click();
    expect(opened).toEqual(["view week"]);

    dispose();
    dom.cleanup();
  });

  test("Space keeps opening the day list after a click, the open list follows a refresh, and a late close keeps a newer quick create", async () => {
    const dom = createDomTestHarness();
    const { default: Calendar } = await import("../src/content/Calendar");
    delegateEvents(["click", "keydown", "pointerdown", "focusin"], dom.document);
    installPopoverApi(dom);
    const [events, setEvents] = createSignal<CalendarEvent[]>([
      { id: "walk", title: "Old title", start: "2026-08-12T09:00:00Z", end: "2026-08-12T10:00:00Z" },
    ]);
    const closes: Array<() => void> = [];
    const dispose = render(
      () =>
        createComponent(Calendar, {
          date: "2026-08-12T12:00:00Z",
          view: "month",
          timeZone: "UTC",
          get events() {
            return events();
          },
          renderQuickCreate: (_value, controls) => {
            closes.push(controls.close);
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
    const popover = () => dom.document.querySelector<HTMLElement>(".k2b-calendar-popover")!;
    const press = (target: HTMLElement, keyName: string) =>
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true }) as unknown as Event);
    const settle = () => new Promise((done) => setTimeout(done, 0));
    const click = async (day: string) => {
      cell(day).dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }) as unknown as Event);
      cell(day).click();
      await settle();
    };

    // After a click the quick create waits quietly, and Space still lists the day.
    await click("2026-08-12");
    expect(popover().dataset.quiet).toBe("true");
    press(cell("2026-08-12"), " ");
    await settle();
    expect(popover().dataset.kind).toBe("day");
    expect(popover().textContent).toContain("Old title");
    // A refresh renames the entry while the list is open.
    setEvents([{ id: "walk", title: "New title", start: "2026-08-12T09:00:00Z", end: "2026-08-12T10:00:00Z" }]);
    expect(popover().textContent).toContain("New title");
    expect(popover().textContent).not.toContain("Old title");
    press(cell("2026-08-12"), "Escape");

    // Any other character, N included, starts the title.
    await click("2026-08-13");
    press(cell("2026-08-13"), "n");
    expect(popover().dataset.quiet).toBeUndefined();
    expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Title");

    // The first quick create closes late, as after a slow save: the one opened since stays open.
    const first = closes.at(-1)!;
    press(cell("2026-08-13"), "Escape");
    press(cell("2026-08-14"), "Enter");
    await settle();
    expect(popover().dataset.kind).toBe("create");
    first();
    expect(popover().dataset.kind).toBe("create");
    closes.at(-1)!();
    expect(popover().dataset.kind).toBeUndefined();

    dispose();
    dom.cleanup();
  });

  test("without application entries the day menu still opens the day; a press on a long bar acts on the day under it, and Escape returns there", async () => {
    const dom = createDomTestHarness();
    const { default: Calendar } = await import("../src/content/Calendar");
    delegateEvents(["click", "keydown", "pointerdown", "contextmenu"], dom.document);
    // The context menu clamps itself to the viewport through a DOMRect, which the harness does not expose.
    const previousDomRect = Object.getOwnPropertyDescriptor(globalThis, "DOMRect");
    Object.defineProperty(globalThis, "DOMRect", { configurable: true, writable: true, value: dom.window.DOMRect });
    const dispose = render(
      () =>
        createComponent(Calendar, {
          date: "2026-08-12T12:00:00Z",
          view: "month",
          timeZone: "UTC",
          events: [{ id: "fair", title: "Fair setup", start: "2026-08-03", end: "2026-08-08", allDay: true }],
          getDateHref: (date, view) => `/calendar?view=${view}&date=${key(date)}`,
        }),
      dom.root,
    );
    // Cells get boxes by their place in the grid: 100 px wide, 80 px tall.
    Array.from(dom.root.querySelectorAll<HTMLElement>("[data-calendar-day-key]")).forEach((cell, index) => {
      const left = (index % 7) * 100;
      const top = Math.floor(index / 7) * 80;
      cell.getBoundingClientRect = () =>
        ({ left, top, right: left + 100, bottom: top + 80, width: 100, height: 80, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    });
    const cell = (day: string) => dom.root.querySelector<HTMLElement>(`[data-calendar-day-key="${day}"]`)!;
    const selected = () =>
      Array.from(dom.root.querySelectorAll<HTMLElement>("[aria-selected='true']"), (element) => element.dataset.calendarDayKey);

    // The bar of August 3 to 7 sits in Monday's cell; the right-click lands on Thursday, August 6.
    const bar = dom.root.querySelector<HTMLElement>("[data-calendar-event]")!;
    expect(bar.closest<HTMLElement>("[data-calendar-day-key]")?.dataset.calendarDayKey).toBe("2026-08-03");
    bar.dispatchEvent(
      new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 350, clientY: 120 }) as unknown as Event,
    );
    await new Promise((done) => setTimeout(done, 0));
    expect(selected()).toEqual(["2026-08-06"]);
    const menu = dom.document.querySelector<HTMLElement>(".k2b-context-menu[role='menu']")!;
    expect(Array.from(menu.querySelectorAll("[role='menuitem']"), (item) => item.textContent?.trim())).toEqual(["Open day", "Open week"]);
    expect(menu.textContent).toContain("Thursday, August 6");

    // Escape gives the focus back to the day, where the arrow keys go on.
    dom.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event,
    );
    expect(dom.document.querySelector(".k2b-context-menu[role='menu']")).toBeNull();
    expect(dom.document.activeElement).toBe(cell("2026-08-06"));

    dispose();
    dom.cleanup();
    if (previousDomRect) Object.defineProperty(globalThis, "DOMRect", previousDomRect);
    else Reflect.deleteProperty(globalThis, "DOMRect");
  });
});
