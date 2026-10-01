import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type {
  DateOverride,
  DateOverrideInput,
  PublicSection,
  PublicSectionInput,
  ShiftAssignment,
  ShiftTemplate,
  UpcomingSlot,
  Venue,
  VenueDashboard,
} from "../src/contracts";

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

/** What assistive technology reads as the control's description. */
const descriptionOf = (control: Element) =>
  (control.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => control.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ");

const buttonNamed = (root: HTMLElement, name: string) => {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);
  if (!button) throw new Error(`No button named ${name}`);
  return button;
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
  accentColor: "#facc15",
  logoBase64: null,
  bannerBase64: null,
  permission: "write",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const template: ShiftTemplate = {
  id: "Temp01",
  venueId: "Cafe01",
  weekday: 1,
  title: "Lunch counter",
  startTime: "11:00",
  endTime: "14:00",
  minPeople: 1,
  maxPeople: 3,
  requireTargetForOpening: false,
  active: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const slot = (date: string, title: string): UpcomingSlot => ({
  date,
  template: { ...template, title },
  startsAt: `${date}T09:00:00.000Z`,
  endsAt: `${date}T12:00:00.000Z`,
  assignedCount: 0,
  minPeople: 1,
  maxPeople: 3,
  missingPeople: 1,
  full: false,
  assignments: [],
});

const dashboard: VenueDashboard = {
  venue,
  openingRules: [],
  overrides: [],
  templates: [template],
  slots: [],
  otherAssignments: [],
  outlook: { startDate: "2026-09-28", endDate: "2026-10-04", missingPeople: 0, nextGap: null },
  assignments: [],
  myUpcomingShifts: [],
  myShiftCount: 0,
  sections: [],
  feedback: { count: 0, averageRating: null, commentCount: 0, buckets: [] },
  feedbackEntries: [],
  feedbackEntriesPage: { page: 1, pageSize: 50, total: 0 },
};

const assignment = (entry: UpcomingSlot, userId: string, userDisplayName: string): ShiftAssignment => ({
  id: `Asg-${userId}`,
  venueId: "Cafe01",
  templateId: entry.template.id,
  templateTitle: entry.template.title,
  userId,
  userDisplayName,
  startsAt: entry.startsAt,
  endsAt: entry.endsAt,
  note: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const withAssignments = (entry: UpcomingSlot, assignments: ShiftAssignment[]): UpcomingSlot => ({
  ...entry,
  assignments,
  assignedCount: assignments.length,
  missingPeople: Math.max(0, entry.minPeople - assignments.length),
});

const addDays = (date: string, days: number) => {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
};

describe("Venue clarity behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("the sign-up dialog lists every shift of its window and loads the next one on request", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const today = dates.formatDateKey(new Date(), { timeZone: venue.timezone });
    const requested: URLSearchParams[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
      requested.push(url.searchParams);
      const start = url.searchParams.get("slotStartDate")!;
      // More than the old cap of 16 in the first window.
      const count = start === today ? 20 : 1;
      const slots = Array.from({ length: count }, (_, index) => slot(addDays(start, 1 + (index % 13)), `Shift ${start} #${index + 1}`));
      return Response.json({ ...dashboard, slots });
    }) as typeof fetch;

    const { SignupDialog, SIGNUP_PAGE_DAYS } = await import("../src/frontend/_components/venue-workspace/signup");
    const dispose = render(() => <SignupDialog dashboard={dashboard} userId="user-1" close={() => {}} />, dom.root);
    try {
      await flush();
      expect(requested.map((query) => [query.get("slotStartDate"), query.get("slotDays")])).toEqual([[today, String(SIGNUP_PAGE_DAYS)]]);
      expect(dom.root.querySelectorAll(".paper").length).toBe(20);
      expect(dom.root.textContent).toContain("20 shifts up to");
      // A shift with free places says so, in words that do not read as the Venue's opening status.
      expect(dom.root.querySelector(".paper .tag")?.textContent).toBe("Free spots");

      buttonNamed(dom.root, "Load more shifts").click();
      await flush();
      expect(requested.at(-1)?.get("slotStartDate")).toBe(addDays(today, SIGNUP_PAGE_DAYS));
      expect(dom.root.querySelectorAll(".paper").length).toBe(21);
      expect(dom.root.textContent).toContain("21 shifts up to");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("the sign-up dialog groups free shifts by day, marks the viewer's own with Leave, and hides full ones until asked", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const today = dates.formatDateKey(new Date(), { timeZone: venue.timezone });
    const mine = slot(addDays(today, 1), "Lunch counter");
    const open = slot(addDays(today, 1), "Evening bar");
    const full = { ...slot(addDays(today, 2), "Brunch"), full: true, missingPeople: 0 };
    const requests: string[] = [];
    let slots = [withAssignments(mine, [assignment(mine, "user-1", "Alex Example")]), open, full];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      requests.push(`${method} ${new URL(url, "http://localhost").pathname}`);
      if (method === "DELETE") {
        slots = [mine, open, full];
        return Response.json({ message: "Shift cancelled" });
      }
      return Response.json({ ...dashboard, slots });
    }) as typeof fetch;

    const { SignupDialog } = await import("../src/frontend/_components/venue-workspace/signup");
    const closes: boolean[] = [];
    const dispose = render(
      () => <SignupDialog dashboard={dashboard} userId="user-1" close={(changed) => closes.push(changed)} />,
      dom.root,
    );
    const cards = () => [...dom.root.querySelectorAll<HTMLElement>("[data-signup-slot]")];
    const card = (title: string) => cards().find((entry) => entry.textContent?.includes(title))!;
    try {
      await flush();
      // Only free is on: the full shift is hidden, and both shifts of the first day sit under one heading.
      const days = [...dom.root.querySelectorAll<HTMLElement>("[data-signup-day]")];
      expect(days.map((day) => day.dataset.signupDay)).toEqual([addDays(today, 1)]);
      expect(days[0]?.querySelector("h3")?.className).toContain("sticky");
      expect(cards().map((entry) => entry.querySelector("p")?.textContent)).toEqual(["Lunch counter", "Evening bar"]);

      expect(card("Lunch counter").textContent).toContain("You're in");
      expect(buttonNamed(card("Lunch counter"), "Leave")).toBeTruthy();
      expect([...card("Lunch counter").querySelectorAll("button")].map((button) => button.textContent?.trim())).not.toContain("Take shift");
      expect(card("Evening bar").querySelector(".tag")?.textContent?.trim()).toBe("Free spots");
      expect(buttonNamed(card("Evening bar"), "Take shift").disabled).toBe(false);

      const onlyFree = dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!;
      expect(onlyFree.checked).toBe(true);
      onlyFree.click();
      await flush();
      expect(card("Brunch")?.querySelector(".tag")?.textContent?.trim()).toBe("Full");
      expect(buttonNamed(card("Brunch"), "Take shift").disabled).toBe(true);

      // Leaving asks first, keeps the dialog open, and reports the change when it closes.
      buttonNamed(card("Lunch counter"), "Leave").click();
      await flush();
      buttonNamed(dom.document.querySelector<HTMLElement>(".k2b-dialog__panel")!, "Leave").click();
      await flush();
      expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([
        "DELETE /api/venue/venues/Cafe01/assignments/Asg-user-1",
      ]);
      expect(buttonNamed(card("Lunch counter"), "Take shift").disabled).toBe(false);
      expect(closes).toEqual([]);
      buttonNamed(dom.root, "Close").click();
      expect(closes).toEqual([true]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("taking a shift with the following weeks says how many it added, and that nothing changed when it added none", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const today = dates.formatDateKey(new Date(), { timeZone: venue.timezone });
    const lunch = slot(addDays(today, 1), "Lunch counter");
    // The server skips weeks the viewer already has or that are full and answers with the sign-ups it made.
    let created: ShiftAssignment[] = [];
    const bodies: unknown[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (method === "POST" && url.includes("/signup-weeks")) {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(created, { status: 201 });
      }
      return Response.json({ ...dashboard, slots: [lunch] });
    }) as typeof fetch;
    const toasts = () => [...dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast-container] [data-k2b-toast]")];

    const { SignupDialog } = await import("../src/frontend/_components/venue-workspace/signup");
    const closes: boolean[] = [];
    const dispose = render(
      () => <SignupDialog dashboard={dashboard} userId="user-1" close={(changed) => closes.push(changed)} />,
      dom.root,
    );
    try {
      await flush();
      // One choice for the whole list instead of a second button per shift.
      const weeks = [...dom.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((input) =>
        input.closest("label")?.textContent?.includes("Also the next 4 weeks"),
      );
      expect(weeks).toHaveLength(1);
      weeks[0]!.click();
      buttonNamed(dom.root, "Take shift").click();
      await flush();
      // This shift and the four following weeks.
      expect(bodies).toEqual([{ date: lunch.date, weeks: 5 }]);
      // Nothing was added, so the dialog stays open and says so instead of reporting a new shift.
      expect(closes).toEqual([]);
      expect(toasts().map((entry) => [entry.dataset.tone, entry.textContent])).toEqual([
        ["info", expect.stringContaining("No shifts taken. You already have these weeks, or they are full.")],
      ]);

      created = [8, 15].map((days) => assignment(slot(addDays(today, days), "Lunch counter"), "user-1", "Alex Example"));
      buttonNamed(dom.root, "Take shift").click();
      await flush();
      expect(closes).toEqual([true]);
      expect(toasts().at(-1)?.dataset.tone).toBe("success");
      expect(toasts().at(-1)?.textContent).toContain("2 shifts taken");
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("free time starts on a quarter hour and adds itself from the dialog footer", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const bodies: { startsAt: string; endsAt: string }[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({}, { status: 201 });
    }) as typeof fetch;

    const { SignupDialog } = await import("../src/frontend/_components/venue-workspace/signup");
    const freeOnly = { ...dashboard, venue: { ...venue, signupMode: "free" as const } };
    const closes: boolean[] = [];
    const dispose = render(() => <SignupDialog dashboard={freeOnly} userId="user-1" close={(changed) => closes.push(changed)} />, dom.root);
    try {
      await flush();
      const add = buttonNamed(dom.root, "Add free shift");
      expect(add.closest("footer")).not.toBeNull();
      add.click();
      await flush();
      const [body] = bodies;
      expect(new Date(body!.startsAt).getTime() % (15 * 60_000)).toBe(0);
      expect(new Date(body!.endsAt).getTime() - new Date(body!.startsAt).getTime()).toBe(2 * 60 * 60_000);
      expect(closes).toEqual([true]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("feedback starts without a rating and sends only the rating the visitor chose", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ venueId: "Cafe01", rating: 3, comment: null, createdAt: new Date().toISOString() }, { status: 201 });
    }) as typeof fetch;

    const { default: PublicFeedbackForm } = await import("../src/frontend/_components/PublicFeedbackForm.island");
    const dispose = render(() => <PublicFeedbackForm venueId="Cafe01" accentColor="#facc15" variant="page" />, dom.root);
    try {
      const radios = [...dom.root.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      const send = buttonNamed(dom.root, "Submit feedback");
      expect(radios.map((radio) => radio.checked)).toEqual([false, false, false, false, false]);
      expect(send.disabled).toBe(true);
      expect(dom.root.textContent).toContain("Choose 1 to 5 stars to send your feedback.");
      // A light accent gets dark text instead of white.
      expect(send.getAttribute("style")).toContain("color: var(--venue-on-accent)");
      expect(send.closest<HTMLElement>("[style*='--venue-on-accent:']")?.style.getPropertyValue("--venue-on-accent")).toBe("#000000");

      radios[2]!.click();
      await flush();
      expect(send.disabled).toBe(false);
      expect(dom.root.textContent).toContain("3 of 5 stars");
      expect(dom.root.textContent).not.toContain("Choose 1 to 5 stars to send your feedback.");

      send.click();
      await flush();
      expect(bodies).toEqual([{ rating: 3, comment: null }]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("saving an edited draft keeps it a draft until the switch says otherwise", async () => {
    const dom = createDomTestHarness();
    const draft: PublicSection = {
      id: "Draft1",
      venueId: "Cafe01",
      kind: "notice",
      title: "Winter hours",
      content: { text: "Closed on Fridays", markdown: "Closed on Fridays" },
      enabled: false,
      position: 4,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const saved: PublicSectionInput[] = [];
    const { PublicSectionDialog } = await import("../src/frontend/_components/venue-workspace/public-sections");
    const dispose = render(
      () => (
        <PublicSectionDialog
          submit={async (value) => {
            saved.push(value);
            // Keeps the dialog open, so the test can save again.
            return "Saved for the test";
          }}
          close={() => {}}
          initial={draft}
          nextPosition={draft.position}
          publicPageEnabled
          submitLabel="Save section"
        />
      ),
      dom.root,
    );
    try {
      const visibility = [...dom.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
        input.closest("label")?.textContent?.includes("Show on the public page"),
      );
      expect(visibility?.checked).toBe(false);
      // The note under the switch says what its current state means.
      const note = () => descriptionOf(visibility!);
      expect(note()).toContain("Draft: only staff and admins see this section.");

      buttonNamed(dom.root, "Save section").click();
      await flush();
      expect(saved.at(-1)).toMatchObject({ title: "Winter hours", enabled: false, position: 4 });

      visibility!.click();
      await flush();
      expect(note()).toContain("Visitors see this section on the public page.");
      expect(note()).not.toContain("Draft");
      buttonNamed(dom.root, "Save section").click();
      await flush();
      expect(saved.at(-1)).toMatchObject({ enabled: true, position: 4 });
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("leaving one of my shifts asks first and shows progress only on that entry", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let finishLeave: (response: Response) => void = () => {};
    const requests: string[] = [];
    const lunch = slot(addDays(dates.formatDateKey(new Date(), { timeZone: venue.timezone }), 2), "Lunch counter");
    const mine = [
      assignment(lunch, "user-1", "Alex Example"),
      { ...assignment(lunch, "user-1", "Alex Example"), id: "Asg-free", templateId: null, templateTitle: null, note: "Inventory count" },
    ];
    const board = { ...dashboard, myUpcomingShifts: mine };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      requests.push(`${method} ${new URL(url, "http://localhost").pathname}`);
      if (method === "DELETE") return new Promise<Response>((resolve) => (finishLeave = resolve));
      return Response.json(board);
    }) as typeof fetch;

    const { LocaleProvider } = await import("@k2b/ui");
    const { default: VenueWorkspace } = await import("../src/frontend/_components/VenueWorkspace.island");
    const dispose = render(
      () => (
        <LocaleProvider locale="en">
          <VenueWorkspace
            dashboard={board}
            dashboardSource={{ venueId: "Cafe01", query: {} }}
            userId="user-1"
            calendarUrl="https://cloud.example.test/api/venue/calendar/calendar-token.ics"
            accessEntries={[]}
            apiKeys={[]}
            initialView="my-shifts"
            initialCalendarView="week"
            initialCalendarDate={lunch.date}
            initialFeedbackDays={30}
            initialFeedbackSearch=""
          />
        </LocaleProvider>
      ),
      dom.root,
    );
    try {
      await flush();
      const rows = [...dom.root.querySelectorAll<HTMLElement>("[data-my-shift]")];
      expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
        expect.stringContaining("11:00–14:00 · Lunch counter"),
        expect.stringContaining("11:00–14:00 · Free time"),
      ]);
      const [first, second] = rows.map((row) => buttonNamed(row, "Leave"));
      expect(first?.dataset.variant).toBe("secondary");

      first!.click();
      await flush();
      const confirmation = dom.document.querySelector<HTMLElement>(".k2b-dialog__panel")!;
      expect(confirmation.textContent).toContain("Leave “Lunch counter” on");
      expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);

      buttonNamed(confirmation, "Leave").click();
      await flush();
      expect(requests.filter((request) => request.startsWith("DELETE"))).toEqual([
        "DELETE /api/venue/venues/Cafe01/assignments/Asg-user-1",
      ]);
      expect(first!.getAttribute("aria-busy")).toBe("true");
      expect(second!.getAttribute("aria-busy")).toBeNull();
      expect(second!.querySelector(".k2b-spin")).toBeNull();

      finishLeave(Response.json({ message: "Shift cancelled" }));
      await flush();
      // The workspace reloads after leaving; no Leave button keeps spinning.
      expect(requests.at(-1)).toBe("GET /api/venue/venues/Cafe01/dashboard");
      expect(dom.root.querySelectorAll("[data-my-shift] [aria-busy]")).toHaveLength(0);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("the calendar subscription offers a webcal link and renews the personal link after a confirmation", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const renewed = "https://cloud.example.test/api/venue/calendar/fresh-token.ics";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      requests.push(`${method} ${new URL(url, "http://localhost").pathname}`);
      return Response.json({ href: renewed });
    }) as typeof fetch;

    const { CalendarSubscriptionDialog } = await import("../src/frontend/_components/venue-workspace/calendar-subscription");
    const handedBack: string[] = [];
    const dispose = render(
      () => (
        <CalendarSubscriptionDialog
          url="https://cloud.example.test/api/venue/calendar/old-token.ics"
          onRenewed={(url) => handedBack.push(url)}
          close={() => {}}
        />
      ),
      dom.root,
    );
    try {
      const link = () => dom.root.querySelector<HTMLInputElement>("input")!;
      const webcal = () =>
        [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((anchor) => anchor.textContent?.includes("Open in calendar app"));
      expect(link().value).toBe("https://cloud.example.test/api/venue/calendar/old-token.ics");
      expect(link().readOnly).toBe(true);
      expect(webcal()?.getAttribute("href")).toBe("webcal://cloud.example.test/api/venue/calendar/old-token.ics");
      expect(buttonNamed(dom.root, "Copy link")).toBeTruthy();
      expect(dom.root.textContent).toContain("This link is personal");

      buttonNamed(dom.root, "Renew link").click();
      await flush();
      const confirmation = dom.document.querySelector<HTMLElement>(".k2b-dialog__panel")!;
      expect(confirmation.textContent).toContain("The old link stops working at once.");
      expect(requests).toEqual([]);

      buttonNamed(confirmation, "Renew link").click();
      await flush();
      expect(requests).toEqual(["POST /api/venue/calendar/my/renew"]);
      expect(link().value).toBe(renewed);
      expect(webcal()?.getAttribute("href")).toBe("webcal://cloud.example.test/api/venue/calendar/fresh-token.ics");
      expect(handedBack).toEqual([renewed]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("copying the public page link shows progress on its own button", async () => {
    const dom = createDomTestHarness();
    const copied: string[] = [];
    const held: Array<() => void> = [];
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) =>
          new Promise<void>((resolve) => {
            copied.push(text);
            held.push(resolve);
          }),
      },
    });
    const { openVenuePublicDisplayDialog } = await import("../src/frontend/_components/venue-workspace/public-display");
    const closed = openVenuePublicDisplayDialog("Cafe01", "en", true);
    try {
      await flush();
      const dialog = dom.document.querySelector<HTMLElement>(".k2b-dialog__panel")!;
      const copy = buttonNamed(dialog, "Copy link");
      copy.click();
      await flush();
      expect(copied).toHaveLength(1);
      expect(copy.getAttribute("aria-busy")).toBe("true");
      expect(buttonNamed(dialog, "Open page").disabled).toBe(true);
      expect(buttonNamed(dialog, "Open page").getAttribute("aria-busy")).toBeNull();

      for (const release of held.splice(0)) release();
      await flush();
      expect(copy.getAttribute("aria-busy")).toBeNull();
      expect(buttonNamed(dialog, "Open page").disabled).toBe(false);
      dialog.querySelector<HTMLButtonElement>(".k2b-dialog__close")!.click();
      await closed;
    } finally {
      dom.cleanup();
    }
  });

  test("a link address visitors cannot follow shows its error at the field and is not saved", async () => {
    const dom = createDomTestHarness();
    const section: PublicSection = {
      id: "Links1",
      venueId: "Cafe01",
      kind: "links",
      title: "Useful links",
      content: { links: [{ label: "Our site", href: "www.cafe.example.org" }] },
      enabled: true,
      position: 2,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const saved: PublicSectionInput[] = [];
    const closed: boolean[] = [];
    const { PublicSectionDialog } = await import("../src/frontend/_components/venue-workspace/public-sections");
    const dispose = render(
      () => (
        <PublicSectionDialog
          submit={async (value) => {
            saved.push(value);
            return null;
          }}
          close={(value) => closed.push(value)}
          initial={section}
          nextPosition={2}
          publicPageEnabled
          submitLabel="Save"
        />
      ),
      dom.root,
    );
    try {
      const address = dom.root.querySelector<HTMLInputElement>('input[placeholder="https://example.com"]')!;
      expect(address.value).toBe("www.cafe.example.org");
      expect(address.getAttribute("aria-invalid")).not.toBe("true");

      buttonNamed(dom.root, "Save").click();
      await flush();
      expect(saved).toEqual([]);
      expect(address.getAttribute("aria-invalid")).toBe("true");
      expect(descriptionOf(address)).toContain("Use a full address starting with https://, mailto:, or tel:, or a path starting with /.");

      address.value = "https://www.cafe.example.org";
      address.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
      expect(address.getAttribute("aria-invalid")).not.toBe("true");
      buttonNamed(dom.root, "Save").click();
      await flush();
      expect(closed).toEqual([true]);
      expect(saved).toEqual([
        {
          kind: "links",
          title: "Useful links",
          content: { links: [{ label: "Our site", href: "https://www.cafe.example.org" }] },
          enabled: true,
          position: 2,
        },
      ]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("the public-page switch does not promise visitors while the Venue's public page is off", async () => {
    const dom = createDomTestHarness();
    const { PublicSectionDialog } = await import("../src/frontend/_components/venue-workspace/public-sections");
    const dispose = render(
      () => <PublicSectionDialog submit={async () => null} close={() => {}} nextPosition={1} publicPageEnabled={false} />,
      dom.root,
    );
    try {
      const visibility = dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!;
      expect(visibility.checked).toBe(true);
      expect(descriptionOf(visibility)).toBe("Visitors see this section once the venue's public page is switched on.");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("editing an exception keeps its kind, so a special opening stays open with its times", async () => {
    const dom = createDomTestHarness();
    const { ExceptionDialog } = await import("../src/frontend/_components/venue-workspace/schedule");
    const exception = (overrides: Partial<DateOverride>): DateOverride => ({
      id: "Exc001",
      venueId: "Cafe01",
      date: "2030-10-17",
      kind: "closed",
      startTime: null,
      endTime: null,
      note: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...overrides,
    });
    /** Opens the dialog for `initial`, saves it unchanged, and returns what it showed and saved. */
    const saveUnchanged = async (initial: DateOverride) => {
      const saved: DateOverrideInput[] = [];
      const closed: boolean[] = [];
      const dispose = render(
        () => (
          <ExceptionDialog
            submit={async (value) => {
              saved.push(value);
              return null;
            }}
            close={(value) => closed.push(value)}
            timeZone="Europe/Berlin"
            initial={initial}
          />
        ),
        dom.root,
      );
      try {
        const text = dom.root.textContent ?? "";
        const inputs = [...dom.root.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value);
        buttonNamed(dom.root, "Save").click();
        for (let index = 0; index < 10; index += 1) await Promise.resolve();
        return { text, inputs, saved, closed };
      } finally {
        dispose();
      }
    };
    try {
      const special = await saveUnchanged(exception({ kind: "open", startTime: "18:00", endTime: "22:00", note: "Long night" }));
      expect(special.text).toContain("Edit exception");
      expect(special.text).toContain("Special opening");
      expect(special.inputs).toEqual(expect.arrayContaining(["18:00", "22:00", "Long night"]));
      expect(special.saved).toEqual([{ date: "2030-10-17", kind: "open", startTime: "18:00", endTime: "22:00", note: "Long night" }]);
      expect(special.closed).toEqual([true]);

      const closed = await saveUnchanged(exception({ id: "Exc002", note: "Staff meeting" }));
      expect(closed.text).toContain("Closed");
      expect(closed.inputs).not.toContain("18:00");
      expect(closed.saved).toEqual([{ date: "2030-10-17", kind: "closed", note: "Staff meeting" }]);
    } finally {
      dom.cleanup();
    }
  });
});
