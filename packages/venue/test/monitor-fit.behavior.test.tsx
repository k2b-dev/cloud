import { describe, expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { PublicOpening, PublicStatus } from "../src/contracts";

const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    for (let step = 0; step < 20; step += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * happy-dom does no layout, so the test lays the monitor out itself: rows 36 px high with 8 px gaps, a block
 * whose heading and padding take 64 px, and a monitor column of `column` px. The column overflows when its
 * blocks at their smallest, plus the feedback code while it shows, need more than that.
 */
const layOut = (dom: DomTestHarness, column: number) => {
  const prototype = dom.window.HTMLElement.prototype;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const blockHeight = (block: HTMLElement) => Math.max(112, Number.parseFloat(block.style.minHeight || "0"));
  const measure = (element: HTMLElement, name: string): number => {
    if (element.matches("[data-fit-row]")) {
      const index = Array.from(element.parentElement!.children).indexOf(element);
      return name === "offsetTop" ? index * 44 : 36;
    }
    if (element.matches("[data-fit-more]") || element.matches("p.absolute")) return 20;
    if (element.matches("[data-public-block]")) return blockHeight(element);
    if (element.parentElement?.matches("[data-public-block]") && element.matches("div")) return blockHeight(element.parentElement) - 64;
    if (element.matches("[data-display-layout]")) {
      if (name === "clientHeight") return column;
      const qr = element.querySelector<HTMLElement>('[data-public-block="feedback-qr"]');
      const blocks = Array.from(element.querySelectorAll<HTMLElement>("[data-public-block]:not([data-public-block='feedback-qr'])"));
      const needed =
        150 + blocks.reduce((sum, block) => sum + blockHeight(block) + 16, 0) + (qr && !qr.classList.contains("hidden") ? 170 : 0);
      return Math.max(column, needed);
    }
    return 0;
  };
  for (const name of ["offsetTop", "offsetHeight", "clientHeight", "scrollHeight"]) {
    originals.set(name, Object.getOwnPropertyDescriptor(prototype, name));
    Object.defineProperty(prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return measure(this, name);
      },
    });
  }
  // Every observer hears about every change, as a browser would report the sizes that changed.
  const observers = new Set<() => void>();
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    #notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.#notify = () => callback([], this as unknown as ResizeObserver);
      observers.add(this.#notify);
    }
    observe() {
      queueMicrotask(this.#notify);
    }
    unobserve() {}
    disconnect() {
      observers.delete(this.#notify);
    }
  } as unknown as typeof ResizeObserver;
  return {
    resize: async () => {
      for (let round = 0; round < 4; round += 1) {
        for (const notify of observers) notify();
        await flush();
      }
    },
    restore: () => {
      globalThis.ResizeObserver = previousObserver;
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(prototype, name, descriptor);
        else Reflect.deleteProperty(prototype, name);
      }
    },
  };
};

const opening = (day: number): PublicOpening => ({
  kind: "shift",
  title: "Additionally open",
  startsAt: `2099-10-${String(day).padStart(2, "0")}T15:00:00.000Z`,
  endsAt: `2099-10-${String(day).padStart(2, "0")}T19:00:00.000Z`,
});

const status: PublicStatus = {
  venue: {
    id: "Cafe01",
    slug: "corner-cafe",
    name: "Corner Café",
    icon: "ti ti-coffee",
    description: null,
    timezone: "Europe/Berlin",
    openMode: "staffed",
    signupMode: "templates",
    publicEnabled: true,
    feedbackEnabled: true,
    accentColor: "#2563eb",
    logoBase64: null,
    bannerBase64: null,
    icalToken: "calendar-token",
    permission: "read",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  open: false,
  spontaneousOpen: false,
  statusLabel: "Closed",
  todayLabel: "No regular hours today",
  nextOpeningLabel: null,
  activeWindowLabel: null,
  upcomingOpenings: [1, 2, 3, 4, 5].map(opening),
  upcomingExceptions: [],
  openingRules: [],
  sections: [],
};

describe("Venue monitor fitting", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const mount = async (column: number, refresh = false) => {
    const dom = createDomTestHarness();
    const layout = layOut(dom, column);
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: PublicVenuePage } = await import("../src/frontend/public/[slug]/PublicVenuePage.island");
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <PublicVenuePage
            venueId="Cafe01"
            initialStatus={status}
            displayHeight="full"
            feedbackUrl="https://cloud.example.test/app/venue/public/Cafe01/feedback"
            refresh={refresh}
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    await layout.resize();
    const openings = () => dom.root.querySelector<HTMLElement>('[data-public-block="openings"]')!;
    return {
      shownRows: () => openings().querySelectorAll("[data-fit-row]:not(.invisible)").length,
      more: () => openings().querySelector("[data-fit-more]")?.textContent ?? null,
      minHeight: () => openings().style.minHeight,
      qrShown: () => !dom.root.querySelector('[data-public-block="feedback-qr"]')?.classList.contains("hidden"),
      hasBlock: (block: string) => dom.root.querySelector(`[data-public-block="${block}"]`) !== null,
      /** Refreshes the status now, as when the monitor's tab becomes visible, without any block reporting a new size. */
      refresh: async () => {
        dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
        await flush();
      },
      done: () => {
        dispose();
        layout.restore();
        dom.cleanup();
      },
    };
  };

  test("a block too short for a row and the count grows to show one row instead of the count alone", async () => {
    const phone = await mount(400);
    try {
      // 64 px of heading and padding, the first 36 px row, and 24 px for "+4 more".
      expect(phone.minHeight()).toBe("124px");
      expect(phone.shownRows()).toBe(1);
      expect(phone.more()).toBe("+4 more");
    } finally {
      phone.done();
    }
  });

  test("the feedback code gives way where the lists need its room and stays where everything fits", async () => {
    const phone = await mount(400);
    try {
      expect(phone.qrShown()).toBeFalse();
    } finally {
      phone.done();
    }
    const tall = await mount(900);
    try {
      expect(tall.qrShown()).toBeTrue();
    } finally {
      tall.done();
    }
  });

  test("a block a refresh adds counts at once, even when the blocks already there keep their size", async () => {
    const originalFetch = globalThis.fetch;
    let next: PublicStatus = status;
    globalThis.fetch = (async () => Response.json(next)) as unknown as typeof fetch;
    // 500 px hold the openings at their smallest and the feedback code, but not a changed-hours block as well.
    const monitor = await mount(500, true);
    try {
      expect(monitor.qrShown()).toBeTrue();
      next = { ...status, upcomingExceptions: [{ date: "2099-10-03", kind: "closed", startTime: null, endTime: null, note: null }] };
      await monitor.refresh();
      expect(monitor.hasBlock("exceptions")).toBeTrue();
      expect(monitor.qrShown()).toBeFalse();
      // Once the changed hours are past, the code has its room again.
      next = status;
      await monitor.refresh();
      expect(monitor.hasBlock("exceptions")).toBeFalse();
      expect(monitor.qrShown()).toBeTrue();
    } finally {
      monitor.done();
      globalThis.fetch = originalFetch;
    }
  });
});
