import { describe, expect, test } from "bun:test";
import { dates } from "@k2b/stdlib";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { UpcomingSlot, Venue, VenueDashboard } from "../src/contracts";

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

const shift: UpcomingSlot = {
  date: shiftDay,
  template: {
    id: "Temp01",
    venueId: "Cafe01",
    weekday: new Date(`${shiftDay}T12:00:00Z`).getUTCDay(),
    title: "Lunch counter",
    startTime: "11:00",
    endTime: "14:00",
    minPeople: 2,
    maxPeople: 3,
    requireTargetForOpening: false,
    active: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  startsAt: `${shiftDay}T09:00:00.000Z`,
  endsAt: `${shiftDay}T12:00:00.000Z`,
  assignedCount: 0,
  minPeople: 2,
  maxPeople: 3,
  missingPeople: 2,
  full: false,
  assignments: [],
};

describe("Venue shift sign-up entry points", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a reader's calendar offers no sign-up by pointer or keyboard, while staff can double-click to join", async () => {
    // One document for both renders: Solid delegates events to the document of the first import.
    const dom = createDomTestHarness();
    const { LocaleProvider } = await import("@k2b/ui");
    const { default: VenueWorkspace } = await import("../src/frontend/_components/VenueWorkspace.island");
    const workspace = (permission: Venue["permission"], signupMode: Venue["signupMode"] = "templates") => {
      const dashboard: VenueDashboard = {
        venue: { ...venue, permission, signupMode },
        openingRules: [],
        overrides: [],
        templates: [shift.template],
        slots: [shift],
        assignments: [],
        myUpcomingShifts: [],
        myShiftCount: 0,
        sections: [],
        feedback: null,
        feedbackEntries: [],
        feedbackEntriesPage: null,
      };
      return render(
        () => (
          <LocaleProvider locale="en">
            <VenueWorkspace
              dashboard={dashboard}
              dashboardSource={{ venueId: "Cafe01", query: {} }}
              userId="user-1"
              calendarUrl="https://cloud.example.test/api/venue/calendar/calendar-token.ics"
              accessEntries={[]}
              apiKeys={[]}
              initialView="shifts"
              initialCalendarView="week"
              initialCalendarDate={shiftDay}
              initialFeedbackDays={30}
              initialFeedbackSearch=""
            />
          </LocaleProvider>
        ),
        dom.root,
      );
    };
    const shiftEntry = () => {
      const entry = [...dom.root.querySelectorAll<HTMLElement>("[data-calendar-event]")].find((node) =>
        node.textContent?.includes("Lunch counter"),
      );
      if (!entry) throw new Error("No calendar entry for the shift");
      return entry;
    };
    const tryToJoin = async () => {
      const entry = shiftEntry();
      entry.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      entry.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flush();
    };

    try {
      for (const [permission, signupMode] of [
        ["read", "templates"],
        // Staff of a Venue that takes only free-time sign-ups cannot join a shift either.
        ["write", "free"],
      ] as const) {
        const dispose = workspace(permission, signupMode);
        await flush();
        expect({ permission, signupMode, tag: shiftEntry().tagName, interactive: shiftEntry().dataset.interactive }).toEqual({
          permission,
          signupMode,
          tag: "DIV",
          interactive: undefined,
        });
        await tryToJoin();
        expect(dom.document.querySelector(".k2b-dialog__panel")).toBeNull();
        expect(dom.root.textContent).toContain("See staffing coverage for the upcoming shifts.");
        expect(dom.root.textContent).toContain("Unfilled spots");
        expect(dom.root.textContent).not.toContain("Free spots");
        dispose();
      }

      const dispose = workspace("write");
      await flush();
      expect(shiftEntry().tagName).toBe("BUTTON");
      expect(dom.root.textContent).toContain("See staffing coverage and take a shift with a free spot.");
      expect(dom.root.textContent).toContain("Free spots");
      shiftEntry().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await flush();
      expect(dom.document.querySelector(".k2b-dialog__panel")?.textContent).toContain("Take this shift?");
      dispose();
    } finally {
      dom.cleanup();
    }
  });
});
