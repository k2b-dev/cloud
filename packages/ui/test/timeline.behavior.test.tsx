import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { TimelineItem } from "../src/content/timeline-model";
import { createDomTestHarness, type DomTestHarness } from "./dom";
import { timelineFrom, timelineItems, timelineNow, timelineTo, timelineZone } from "./timeline-data";

const key = (dom: DomTestHarness, target: Element, value: string) => {
  const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  target.dispatchEvent(event);
  return event;
};
const focused = (dom: DomTestHarness) => (dom.document.activeElement as HTMLElement | null)?.dataset.entryId;
const tabStops = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[tabindex="0"]')].map((element) => element.dataset.entryId);

describe("Timeline keyboard and activation", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }

  const mount = async (items: TimelineItem[] = timelineItems, extra: { readOnly?: boolean } = {}) => {
    const dom = createDomTestHarness();
    dom.root.classList.add("k2b-ui");
    delegateEvents(["click", "keydown", "focusin"], dom.document);
    const { Timeline } = await import("../src/content");
    const activated: string[] = [];
    const toggled: Array<[string, boolean]> = [];
    const [list, setList] = createSignal(items);
    const dispose = render(
      () => (
        <Timeline
          items={list()}
          from={timelineFrom}
          to={timelineTo}
          now={timelineNow}
          timeZone={timelineZone}
          onActivate={(item) => activated.push(item.id)}
          onToggle={
            extra.readOnly
              ? undefined
              : (item, checked) => {
                  toggled.push([item.id, checked]);
                  setList((current) => current.map((entry) => (entry.id === item.id ? { ...entry, checked } : entry)));
                }
          }
        />
      ),
      dom.root,
    );
    const item = (id: string) => dom.root.querySelector<HTMLElement>(`[data-entry-id="${id}"]`)!;
    const start = (id: string) => {
      item(id).focus();
      return item(id);
    };
    return { dom, dispose, activated, toggled, item, start, setList };
  };

  test("is one tab stop that the arrow keys move through every item, across days", async () => {
    const { dom, dispose, start } = await mount();
    try {
      expect(tabStops(dom.root)).toEqual(["t1"]);
      start("e7");
      key(dom, dom.document.activeElement!, "ArrowRight");
      // Friday begins with the night item before its first band.
      expect(focused(dom)).toBe("n1");
      expect(tabStops(dom.root)).toEqual(["n1"]);
      key(dom, dom.document.activeElement!, "ArrowLeft");
      key(dom, dom.document.activeElement!, "ArrowLeft");
      expect(focused(dom)).toBe("t2");
      // Arrows across the axis keep their native meaning.
      expect(key(dom, dom.document.activeElement!, "ArrowDown").defaultPrevented).toBe(false);
      expect(focused(dom)).toBe("t2");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("Page Up and Page Down change the day, Home and End go to its first and last item, T to now", async () => {
    const { dom, dispose, start } = await mount();
    try {
      start("e5");
      key(dom, dom.document.activeElement!, "PageDown");
      expect(focused(dom)).toBe("n1");
      key(dom, dom.document.activeElement!, "PageDown");
      // The weekend fold has no items; Monday starts with its all-day item.
      expect(focused(dom)).toBe("a3");
      key(dom, dom.document.activeElement!, "End");
      expect(focused(dom)).toBe("e20");
      key(dom, dom.document.activeElement!, "Home");
      expect(focused(dom)).toBe("a3");
      key(dom, dom.document.activeElement!, "PageUp");
      expect(focused(dom)).toBe("n1");
      key(dom, dom.document.activeElement!, "t");
      // 14:20 lies between the design review (until 13:45) and the 15:30 deadline.
      expect(focused(dom)).toBe("t1");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("Space checks a task when the reader may change it and opens other items; a click opens them", async () => {
    const { dom, dispose, start, toggled, activated, item } = await mount();
    try {
      start("t1");
      expect(key(dom, item("t1"), " ").defaultPrevented).toBe(true);
      expect(toggled).toEqual([["t1", true]]);
      expect(item("t1").getAttribute("aria-label")).toBe("Release planning slides, 15:30, Task, Thursday, October 8, done");
      // The same element stays focused while its item changes.
      expect(focused(dom)).toBe("t1");
      key(dom, item("e6"), " ");
      expect(activated).toEqual(["e6"]);
      item("e3").click();
      expect(activated).toEqual(["e6", "e3"]);
      item("t2").querySelector<HTMLElement>(".k2b-timeline__check")!.click();
      expect(toggled).toEqual([
        ["t1", true],
        ["t2", true],
      ]);
      expect(activated).toEqual(["e6", "e3"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("without onToggle, Space and the box open the task instead of changing it", async () => {
    const { dom, dispose, start, toggled, activated, item } = await mount(timelineItems, { readOnly: true });
    try {
      start("t1");
      key(dom, item("t1"), " ");
      item("t2").querySelector<HTMLElement>(".k2b-timeline__check")!.click();
      expect(toggled).toEqual([]);
      expect(activated).toEqual(["t1", "t2"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("keeps the focused item when items change around it", async () => {
    const { dom, dispose, start, setList, item } = await mount();
    try {
      const element = start("e6");
      setList((current) => [...current, { id: "late", label: "Late addition", start: "2026-10-08T20:00:00+02:00", kind: "marker" }]);
      expect(item("e6")).toBe(element);
      expect(focused(dom)).toBe("e6");
      expect(tabStops(dom.root)).toEqual(["e6"]);
      setList((current) => current.filter((entry) => entry.id !== "e6"));
      // The tab stop falls back to the next item after now.
      expect(tabStops(dom.root)).toEqual(["t1"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
