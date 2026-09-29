import { afterEach, describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";
import type { ShiftAssignment, UpcomingSlot, Venue, VenueDashboard } from "../src/contracts";

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const venue: Venue = {
  id: "Cafe01",
  slug: "corner-cafe",
  name: "Corner Café",
  icon: "ti ti-coffee",
  description: null,
  timezone: "Europe/Berlin",
  openMode: "combined",
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
};

const addDays = (date: string, days: number) => {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
};

// Tomorrow in the Venue's time zone, so the shift has not ended while the test runs.
const shiftDay = addDays(dates.formatDateKey(new Date(), { timeZone: venue.timezone }), 1);

const person = (id: string, userId: string, userDisplayName: string, overrides: Partial<ShiftAssignment> = {}): ShiftAssignment => ({
  id,
  venueId: "Cafe01",
  templateId: "Temp01",
  templateTitle: "Lunch counter",
  userId,
  userDisplayName,
  startsAt: `${shiftDay}T09:00:00.000Z`,
  endsAt: `${shiftDay}T12:00:00.000Z`,
  note: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const people = [person("Asg002", "user-2", "Sam Sample"), person("Asg003", "user-3", "Kim Muster")];
const shift: UpcomingSlot = {
  date: shiftDay,
  template: {
    id: "Temp01",
    venueId: "Cafe01",
    weekday: new Date(`${shiftDay}T12:00:00Z`).getUTCDay(),
    title: "Lunch counter",
    startTime: "11:00",
    endTime: "14:00",
    minPeople: 3,
    maxPeople: 4,
    requireTargetForOpening: false,
    active: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  startsAt: `${shiftDay}T09:00:00.000Z`,
  endsAt: `${shiftDay}T12:00:00.000Z`,
  assignedCount: 2,
  minPeople: 3,
  maxPeople: 4,
  missingPeople: 1,
  full: false,
  assignments: people,
};
const freeTime = person("Asg005", "user-5", "Robin Probe", {
  templateId: null,
  templateTitle: null,
  startsAt: `${shiftDay}T13:00:00.000Z`,
  endsAt: `${shiftDay}T14:00:00.000Z`,
  note: "Inventory count",
});

const board = (permission: Venue["permission"], slot: UpcomingSlot = shift): VenueDashboard => ({
  venue: { ...venue, permission },
  openingRules: [],
  overrides: [],
  templates: [shift.template],
  slots: [slot],
  otherAssignments: [freeTime],
  outlook: { startDate: shiftDay, endDate: addDays(shiftDay, 6), missingPeople: 1, nextGap: null },
  assignments: [],
  myUpcomingShifts: [],
  myShiftCount: 0,
  sections: [],
  feedback: null,
  feedbackEntries: [],
  feedbackEntriesPage: null,
});

const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );

/** The shift with the viewer (`user-1`) signed up as well. */
const mine = person("Asg001", "user-1", "Alex Example");
const shiftWithMine: UpcomingSlot = {
  ...shift,
  assignments: [...people, mine],
  assignedCount: 3,
  missingPeople: 0,
};

type Request = { method: string; path: string; body: unknown };

const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");

/** One document for every render: Solid delegates events to the document of the first import. */
const harness = async (dom: DomTestHarness) => {
  // Replacing the URL keeps the detail's scroll position through `CSS.escape`, which the DOM harness leaves out.
  Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
  const requests: Request[] = [];
  let holdDeletes = false;
  const held: Array<() => void> = [];
  /** What the dashboard reload returns after a change. */
  let served = board("admin");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === "DELETE") {
      const response = () => Response.json({ message: "Shift cancelled" });
      if (!holdDeletes) return response();
      return new Promise<Response>((resolve) => held.push(() => resolve(response())));
    }
    if (method === "POST") return Response.json([], { status: 201 });
    return Response.json(served);
  }) as typeof fetch;

  const { LocaleProvider } = await import("@k2b/ui");
  const { default: VenueWorkspace } = await import("../src/frontend/_components/VenueWorkspace.island");
  const mount = (
    permission: Venue["permission"],
    options: {
      width?: number;
      initialShiftId?: string | null;
      viewSource?: "url" | "cookie" | "default";
      calendarView?: "week" | "mobile-month";
      dashboard?: VenueDashboard;
    } = {},
  ) => {
    dom.window.happyDOM.setViewport({ width: options.width ?? 1440, height: 900 });
    const shared = options.initialShiftId ? `&shift=${options.initialShiftId}` : "";
    dom.window.history.replaceState(null, "", `/app/venue/Cafe01/shifts?cv=${options.calendarView ?? "week"}&cd=${shiftDay}${shared}`);
    return render(
      () => (
        <LocaleProvider locale="en">
          <VenueWorkspace
            dashboard={options.dashboard ?? board(permission)}
            dashboardSource={{ venueId: "Cafe01", query: {} }}
            userId="user-1"
            calendarUrl="https://cloud.example.test/api/venue/calendar/calendar-token.ics"
            accessEntries={[]}
            apiKeys={[]}
            initialView="shifts"
            initialCalendarView={options.calendarView ?? "week"}
            initialCalendarViewSource={options.viewSource ?? "url"}
            initialCalendarDate={shiftDay}
            initialShiftId={options.initialShiftId ?? null}
            initialFeedbackDays={30}
            initialFeedbackSearch=""
          />
        </LocaleProvider>
      ),
      dom.root,
    );
  };
  const entry = (title: string) => {
    const found = [...dom.root.querySelectorAll<HTMLElement>("[data-calendar-event]")].find((node) => node.textContent?.includes(title));
    if (!found) throw new Error(`No calendar entry for ${title}`);
    return found;
  };
  /** One tap or click: a single activation, no double-click. */
  const tap = async (title: string) => {
    entry(title).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await flush();
  };
  const detail = () => dom.root.querySelector<HTMLElement>(".k2b-app-workspace__detail")!;
  const sheet = () => dom.document.querySelector<HTMLElement>(".k2b-bottom-sheet-frame");
  const selectedInUrl = () => new URL(dom.window.location.href).searchParams.get("shift");
  const gapsInUrl = () => new URL(dom.window.location.href).searchParams.get("gaps");
  const titles = () => [...dom.root.querySelectorAll<HTMLElement>("[data-calendar-event]")].map((node) => node.textContent ?? "");
  const chooseFilter = async (label: string) => {
    const option = [...dom.root.querySelectorAll<HTMLElement>("[role='menuitemradio']")].find((node) => node.textContent?.includes(label));
    if (!option) throw new Error(`No filter option ${label}`);
    option.click();
    await flush();
  };
  return {
    requests,
    mount,
    entry,
    tap,
    detail,
    sheet,
    selectedInUrl,
    gapsInUrl,
    titles,
    chooseFilter,
    serve: (next: VenueDashboard) => {
      served = next;
    },
    holdDeletes: () => {
      holdDeletes = true;
    },
    releaseDeletes: () => {
      for (const release of held.splice(0)) release();
    },
  };
};

describe("Venue shift detail", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  afterEach(() => {
    if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
    else Reflect.deleteProperty(globalThis, "CSS");
  });

  test("one click opens the detail beside the calendar, with actions that follow the viewer's access", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    try {
      const page = await harness(dom);

      // Readers see the shift and its people, but no action.
      let dispose = page.mount("read");
      await flush();
      expect(page.detail().hidden).toBe(true);
      expect(page.entry("Lunch counter").tagName).toBe("A");
      await page.tap("Lunch counter");
      expect(page.selectedInUrl()).toBe(`Temp01:${shiftDay}`);
      expect((dom.window.history.state as { venueShiftSelection?: boolean }).venueShiftSelection).toBe(true);
      expect(page.detail().hidden).toBe(false);
      expect(page.detail().textContent).toContain("Sam Sample");
      expect(page.detail().textContent).toContain("2 of 3–4 staffed");
      expect(page.detail().querySelectorAll("button:not([aria-label='Close shift details'])")).toHaveLength(0);
      expect(page.sheet()).toBeNull();
      dispose();

      // Staff take the shift, optionally with the following weeks, but remove nobody.
      dispose = page.mount("write");
      await flush();
      await page.tap("Lunch counter");
      expect(buttonNamed(page.detail(), "Remove Sam Sample")).toBeUndefined();
      const weeks = [...page.detail().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
        input.closest("label")?.textContent?.includes("Also the next 4 weeks"),
      )!;
      weeks.click();
      buttonNamed(page.detail(), "Take shift")!.click();
      await flush();
      expect(page.requests.filter((request) => request.method === "POST")).toEqual([
        { method: "POST", path: "/api/venue/venues/Cafe01/templates/Temp01/signup-weeks", body: { date: shiftDay, weeks: 5 } },
      ]);
      dispose();

      // Admins remove another person after a confirmation; only that person's button shows progress.
      dispose = page.mount("admin");
      await flush();
      await page.tap("Lunch counter");
      page.holdDeletes();
      buttonNamed(page.detail(), "Remove Sam Sample")!.click();
      await flush();
      const confirmation = dom.document.querySelector<HTMLElement>(".k2b-dialog__panel")!;
      expect(confirmation.textContent).toContain("Remove Sam Sample from “Lunch counter” on");
      buttonNamed(confirmation, "Remove")!.click();
      await flush();
      expect(page.requests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([
        "/api/venue/venues/Cafe01/assignments/Asg002",
      ]);
      const removeSam = buttonNamed(page.detail(), "Remove Sam Sample")!;
      const removeKim = buttonNamed(page.detail(), "Remove Kim Muster")!;
      expect(removeSam.getAttribute("aria-busy")).toBe("true");
      // Unrelated actions stay available while the removal runs.
      expect(removeKim.disabled).toBe(false);
      expect(removeKim.getAttribute("aria-busy")).toBeNull();
      expect(buttonNamed(page.detail(), "Take shift")!.disabled).toBe(false);
      page.releaseDeletes();
      await flush();
      expect(page.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/venue/venues/Cafe01/dashboard" });

      // Closing ends the selection.
      buttonNamed(page.detail(), "Close shift details")!.click();
      await flush();
      expect(page.detail().hidden).toBe(true);
      dispose();
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("below 1024 px one tap opens the same detail in a bottom sheet with touch-sized actions", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    try {
      const page = await harness(dom);
      const dispose = page.mount("write", { width: 390 });
      await flush();
      await page.tap("Lunch counter");
      const sheet = page.sheet()!;
      expect(sheet).not.toBeNull();
      expect(page.detail().hidden).toBe(true);
      expect(sheet.textContent).toContain("Lunch counter");
      expect(sheet.textContent).toContain("Sam Sample");
      expect(buttonNamed(sheet, "Take shift")?.dataset.size).toBe("md");
      expect(page.selectedInUrl()).toBe(`Temp01:${shiftDay}`);

      buttonNamed(sheet, "Close shift details")!.click();
      await flush();
      expect(dom.document.querySelector(".k2b-bottom-sheet-frame [data-shift-detail-sheet]")).toBeNull();

      // Free time shows in the calendar and opens the same detail.
      await page.tap("Free time");
      expect(page.sheet()?.textContent).toContain("Robin Probe");
      expect(page.sheet()?.textContent).toContain("Inventory count");
      expect(page.selectedInUrl()).toBe("a:Asg005");
      dispose();
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("the URL restores the selection, and Back and Forward follow it", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    try {
      const page = await harness(dom);
      const dispose = page.mount("read", { initialShiftId: "a:Asg005" });
      await flush();
      expect(page.detail().hidden).toBe(false);
      expect(page.detail().textContent).toContain("Robin Probe");

      const travel = async (search: string) => {
        dom.window.history.pushState(null, "", `/app/venue/Cafe01/shifts${search}`);
        dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
        await flush();
      };
      await travel(`?cv=week&cd=${shiftDay}`);
      expect(page.detail().hidden).toBe(true);
      await travel(`?cv=week&cd=${shiftDay}&shift=Temp01:${shiftDay}`);
      expect(page.detail().hidden).toBe(false);
      expect(page.detail().textContent).toContain("Kim Muster");
      dispose();
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("closing a detail leaves the schedule as the person left it", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    try {
      const page = await harness(dom);

      // A shared link opens a shift; picking another one replaces it, so closing does not reopen the first.
      let dispose = page.mount("read", { initialShiftId: `Temp01:${shiftDay}` });
      await flush();
      expect(page.detail().textContent).toContain("Kim Muster");
      const entries = dom.window.history.length;
      await page.tap("Free time");
      expect(page.selectedInUrl()).toBe("a:Asg005");
      expect(dom.window.history.length).toBe(entries);
      buttonNamed(page.detail(), "Close shift details")!.click();
      await flush();
      expect(page.detail().hidden).toBe(true);
      expect(page.selectedInUrl()).toBeNull();
      dispose();

      // Without a change, closing goes back to where the person came from.
      dispose = page.mount("read");
      await flush();
      await page.tap("Lunch counter");
      buttonNamed(page.detail(), "Close shift details")!.click();
      await flush();
      expect(page.detail().hidden).toBe(true);
      expect(page.selectedInUrl()).toBeNull();
      expect(dom.window.history.state).toBeNull();

      // The gaps filter chosen while the detail is open stays on after closing it.
      await page.tap("Lunch counter");
      await page.chooseFilter("Gaps only");
      expect({ shift: page.selectedInUrl(), gaps: page.gapsInUrl() }).toEqual({ shift: `Temp01:${shiftDay}`, gaps: "1" });
      buttonNamed(page.detail(), "Close shift details")!.click();
      await flush();
      expect(page.detail().hidden).toBe(true);
      expect({ shift: page.selectedInUrl(), gaps: page.gapsInUrl() }).toEqual({ shift: null, gaps: "1" });
      expect(page.titles().some((title) => title.includes("Free time"))).toBe(false);
      dispose();
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("leaving a shift opened from My shifts keeps its detail open on the shift", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    try {
      const page = await harness(dom);
      for (const width of [1440, 390]) {
        page.serve(board("write"));
        const dispose = page.mount("write", { width, initialShiftId: "a:Asg001", dashboard: board("write", shiftWithMine) });
        await flush();
        const surface = () => (width === 1440 ? page.detail() : page.sheet()!);
        const opened = surface();
        expect(opened.textContent).toContain("Alex Example (you)");

        buttonNamed(surface(), "Leave")!.click();
        await flush();
        buttonNamed(dom.document.querySelector<HTMLElement>(".k2b-dialog__panel")!, "Leave")!.click();
        await flush();
        expect(page.requests.at(-2)).toMatchObject({ method: "DELETE", path: "/api/venue/venues/Cafe01/assignments/Asg001" });
        // The sign-up is gone; the same detail stays on the shift and offers Take again.
        expect(page.selectedInUrl()).toBe(`Temp01:${shiftDay}`);
        expect(surface()).toBe(opened);
        expect(surface().textContent).not.toContain("Alex Example");
        expect(buttonNamed(surface(), "Take shift")).toBeDefined();
        dispose();
      }
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("the phone month brings the chosen day's shifts into view below its grid", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const scrolled: Array<{ target: string; options: unknown }> = [];
    const prototype = dom.window.HTMLElement.prototype as HTMLElement;
    const previousScroll = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
    Object.defineProperty(prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement, options?: ScrollIntoViewOptions) {
        scrolled.push({ target: this.className, options });
      },
    });
    try {
      const page = await harness(dom);
      let dispose = page.mount("write", { width: 390, calendarView: "mobile-month" });
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrolled).toEqual([{ target: "k2b-calendar-mobile-month__agenda", options: { block: "nearest" } }]);
      expect(dom.root.querySelector(".k2b-content-calendar")?.className).not.toContain("min-h-[42rem]");
      dispose();

      // The week and day grids keep their place and their full height.
      scrolled.length = 0;
      dispose = page.mount("write", { width: 1440 });
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrolled).toEqual([]);
      expect(dom.root.querySelector(".k2b-content-calendar")?.className).toContain("min-h-[42rem]");
      dispose();
    } finally {
      if (previousScroll) Object.defineProperty(prototype, "scrollIntoView", previousScroll);
      else Reflect.deleteProperty(prototype, "scrollIntoView");
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("a first visit on a phone switches once to the phone month view, and every visit remembers the view", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const replaced: string[] = [];
    Object.defineProperty(dom.window.location, "replace", { configurable: true, value: (href: string) => replaced.push(href) });
    const cookie = () => /venue_calendar_view=([^;]+)/.exec(dom.document.cookie)?.[1];
    try {
      const page = await harness(dom);
      let dispose = page.mount("read", { width: 1440, viewSource: "default" });
      await flush();
      expect({ replaced, cookie: cookie() }).toEqual({ replaced: [], cookie: "week" });
      dispose();

      dispose = page.mount("read", { width: 390, viewSource: "cookie" });
      await flush();
      // A remembered view stays, also on a phone.
      expect(replaced).toEqual([]);
      dispose();

      dispose = page.mount("read", { width: 390, viewSource: "default" });
      await flush();
      expect(replaced).toEqual([`/app/venue/Cafe01/shifts?cv=mobile-month&cd=${shiftDay}`]);
      expect(cookie()).toBe("mobile-month");
      dispose();
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
