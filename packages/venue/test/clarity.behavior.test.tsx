import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type {
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
  icalToken: "calendar-token",
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

  test("the sign-up dialog marks shifts the viewer already joined instead of offering them again", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const today = dates.formatDateKey(new Date(), { timeZone: venue.timezone });
    const mine = slot(addDays(today, 1), "Lunch counter");
    const theirs = slot(addDays(today, 2), "Evening bar");
    globalThis.fetch = (async () =>
      Response.json({
        ...dashboard,
        slots: [
          withAssignments(mine, [assignment(mine, "user-1", "Alex Example")]),
          withAssignments(theirs, [assignment(theirs, "user-2", "Sam Sample")]),
        ],
      })) as typeof fetch;

    const { SignupDialog } = await import("../src/frontend/_components/venue-workspace/signup");
    const dispose = render(() => <SignupDialog dashboard={dashboard} userId="user-1" close={() => {}} />, dom.root);
    try {
      await flush();
      const [joinedCard, openCard] = [...dom.root.querySelectorAll<HTMLElement>(".paper")];
      expect(joinedCard?.querySelector(".tag")?.textContent?.trim()).toBe("You're in");
      expect(buttonNamed(joinedCard!, "Take shift").disabled).toBe(true);
      // Joining the following weeks still adds shifts the viewer does not have yet.
      expect(buttonNamed(joinedCard!, "Take the next 4 weeks").disabled).toBe(false);

      expect(openCard?.querySelector(".tag")?.textContent?.trim()).toBe("Free spots");
      expect(buttonNamed(openCard!, "Take shift").disabled).toBe(false);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("joining the next weeks says how many shifts it added, and that nothing changed when it added none", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const today = dates.formatDateKey(new Date(), { timeZone: venue.timezone });
    const mine = slot(addDays(today, 1), "Lunch counter");
    // The server skips weeks the viewer already has or that are full and answers with the sign-ups it made.
    let created: ShiftAssignment[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (method === "POST" && url.includes("/signup-weeks")) return Response.json(created, { status: 201 });
      return Response.json({ ...dashboard, slots: [withAssignments(mine, [assignment(mine, "user-1", "Alex Example")])] });
    }) as typeof fetch;
    const toasts = () => [...dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast-container] > [data-tone]")];

    const { SignupDialog } = await import("../src/frontend/_components/venue-workspace/signup");
    const closes: boolean[] = [];
    const dispose = render(
      () => <SignupDialog dashboard={dashboard} userId="user-1" close={(changed) => closes.push(changed)} />,
      dom.root,
    );
    try {
      await flush();
      buttonNamed(dom.root, "Take the next 4 weeks").click();
      await flush();
      // Nothing was added, so the dialog stays open and says so instead of reporting a new shift.
      expect(closes).toEqual([]);
      expect(toasts().map((entry) => [entry.dataset.tone, entry.textContent])).toEqual([
        ["info", expect.stringContaining("No shifts taken. You already have these weeks, or they are full.")],
      ]);

      created = [8, 15].map((days) => assignment(slot(addDays(today, days), "Lunch counter"), "user-1", "Alex Example"));
      buttonNamed(dom.root, "Take the next 4 weeks").click();
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
    const saved: Array<PublicSectionInput | null> = [];
    const { PublicSectionDialog } = await import("../src/frontend/_components/venue-workspace/public-sections");
    const dispose = render(
      () => (
        <PublicSectionDialog
          close={(value) => saved.push(value)}
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
      expect(saved.at(-1)).toMatchObject({ title: "Winter hours", enabled: false, position: 4 });

      visibility!.click();
      await flush();
      expect(note()).toContain("Visitors see this section on the public page.");
      expect(note()).not.toContain("Draft");
      buttonNamed(dom.root, "Save section").click();
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
      { ...assignment(lunch, "user-1", "Alex Example"), id: "Asg-free", templateId: null, note: "Inventory count" },
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

  test("the public-page switch does not promise visitors while the Venue's public page is off", async () => {
    const dom = createDomTestHarness();
    const { PublicSectionDialog } = await import("../src/frontend/_components/venue-workspace/public-sections");
    const dispose = render(() => <PublicSectionDialog close={() => {}} nextPosition={1} publicPageEnabled={false} />, dom.root);
    try {
      const visibility = dom.root.querySelector<HTMLInputElement>('input[role="switch"]')!;
      expect(visibility.checked).toBe(true);
      expect(descriptionOf(visibility)).toBe("Visitors see this section once the venue's public page is switched on.");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
