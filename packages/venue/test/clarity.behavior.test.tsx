import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PublicSection, PublicSectionInput, ShiftTemplate, UpcomingSlot, Venue, VenueDashboard } from "../src/contracts";

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

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
    const dispose = render(() => <SignupDialog dashboard={dashboard} close={() => {}} />, dom.root);
    try {
      await flush();
      expect(requested.map((query) => [query.get("slotStartDate"), query.get("slotDays")])).toEqual([[today, String(SIGNUP_PAGE_DAYS)]]);
      expect(dom.root.querySelectorAll(".paper").length).toBe(20);
      expect(dom.root.textContent).toContain("20 shifts up to");
      // A shift with free places says so, in words that do not read as the Venue's opening status.
      expect(dom.root.querySelector(".paper .tag")?.textContent).toBe("Open spots");

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

      buttonNamed(dom.root, "Save section").click();
      expect(saved.at(-1)).toMatchObject({ title: "Winter hours", enabled: false, position: 4 });

      visibility!.click();
      await flush();
      buttonNamed(dom.root, "Save section").click();
      expect(saved.at(-1)).toMatchObject({ enabled: true, position: 4 });
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
