import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
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

// Exercise quarter-hour rounding as well as a fixed Berlin summer-time offset.
const fixtureNow = "2026-09-28T10:07:13.000Z";

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
  date: null,
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

  // Keep relative fixture days and their Berlin offset independent of the calendar.
  beforeEach(() => setSystemTime(new Date(fixtureNow)));
  afterEach(() => setSystemTime());

  test("feedback starts without a rating and sends only the rating the visitor chose", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ venueId: "Cafe01", rating: 3, comment: null, createdAt: new Date(fixtureNow).toISOString() }, { status: 201 });
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
      expect(special.text).toContain("Edit opening-hour exception");
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
