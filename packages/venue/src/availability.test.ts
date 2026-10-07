// fallow-ignore-file unused-file
import { describe, expect, test } from "bun:test";
import { buildPublicAvailability, upcomingPublicExceptions } from "./availability";
import type { DateOverride, OpeningRule, ShiftAssignment, ShiftTemplate } from "./contracts";

const timestamp = "2026-07-01T00:00:00.000Z";

const openingRule = (overrides: Partial<OpeningRule> = {}): OpeningRule => ({
  id: "rule-1",
  venueId: "venue-1",
  weekday: 1,
  startTime: "09:00",
  endTime: "17:00",
  note: null,
  position: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const shiftTemplate = (overrides: Partial<ShiftTemplate> = {}): ShiftTemplate => ({
  id: "shift-1",
  venueId: "venue-1",
  weekday: 1,
  date: null,
  title: "Service desk",
  startTime: "10:00",
  endTime: "12:00",
  minPeople: 2,
  maxPeople: 4,
  requireTargetForOpening: false,
  active: true,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const assignment = (overrides: Partial<ShiftAssignment> = {}): ShiftAssignment => ({
  id: "assignment-1",
  venueId: "venue-1",
  templateId: "shift-1",
  templateTitle: "Service desk",
  userId: "user-1",
  userDisplayName: "Private volunteer",
  startsAt: "2026-07-13T08:00:00.000Z",
  endsAt: "2026-07-13T10:00:00.000Z",
  note: "Private note",
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
});

const closedOverride = (): DateOverride => ({
  id: "override-1",
  venueId: "venue-1",
  date: "2026-07-13",
  kind: "closed",
  startTime: null,
  endTime: null,
  note: "Holiday",
  createdAt: timestamp,
  updatedAt: timestamp,
});

const project = (input: Partial<Parameters<typeof buildPublicAvailability>[0]> = {}) =>
  buildPublicAvailability({
    venue: { openMode: "combined", timezone: "Europe/Berlin" },
    openingRules: [],
    overrides: [],
    templates: [],
    assignments: [],
    now: new Date("2026-07-13T08:30:00.000Z"),
    days: 7,
    ...input,
  });

describe("buildPublicAvailability", () => {
  test("a one-off opens only on its date and still requires its target", () => {
    const input = {
      venue: { openMode: "staffed" as const, timezone: "Europe/Berlin" },
      templates: [shiftTemplate({ date: "2026-07-13", requireTargetForOpening: true })],
      days: 14,
    };
    expect(project({ ...input, assignments: [assignment()] }).open).toBeFalse();
    const staffed = [assignment(), assignment({ id: "assignment-2", userId: "user-2" })];
    expect(project({ ...input, assignments: staffed }).open).toBeTrue();
    // Even stale assignments on the same weekday cannot make another occurrence of a dated template.
    const nextWeek = staffed.map((entry) => ({ ...entry, startsAt: "2026-07-20T08:00:00.000Z", endsAt: "2026-07-20T10:00:00.000Z" }));
    expect(project({ ...input, assignments: [...staffed, ...nextWeek] }).upcomingOpenings).toEqual([]);
    expect(project({ ...input, assignments: nextWeek, now: new Date("2026-07-20T08:30:00Z") }).open).toBeFalse();
  });

  test("lists a future one-off staffed opening without changing opening-hour exceptions", () => {
    const result = project({
      templates: [shiftTemplate({ date: "2026-07-20" })],
      assignments: [assignment({ startsAt: "2026-07-20T08:00:00.000Z", endsAt: "2026-07-20T10:00:00.000Z" })],
      days: 14,
    });
    expect(result.upcomingOpenings.map((entry) => entry.startsAt)).toEqual(["2026-07-20T08:00:00.000Z"]);
    expect(result.upcomingExceptions).toEqual([]);
  });

  test("opens during regular hours", () => {
    const result = project({ openingRules: [openingRule()] });

    expect(result.open).toBe(true);
    expect(result.spontaneousOpen).toBe(false);
    expect(result.todayLabel).toBe("09:00–17:00");
  });

  test("reads an end time of 24:00 as midnight, for opening hours and for shifts", () => {
    const lateEvening = new Date("2026-07-13T21:30:00.000Z");
    const hours = project({ openingRules: [openingRule({ startTime: "18:00", endTime: "24:00" })], now: lateEvening });
    expect([hours.open, hours.todayLabel, hours.activeWindowLabel]).toEqual([true, "18:00–00:00", "18:00–00:00"]);

    const shift = project({
      venue: { openMode: "staffed", timezone: "Europe/Berlin" },
      templates: [shiftTemplate({ startTime: "18:00", endTime: "24:00" })],
      assignments: [assignment({ startsAt: "2026-07-13T16:00:00.000Z", endsAt: "2026-07-13T22:00:00.000Z" })],
      now: lateEvening,
    });
    expect([shift.open, shift.activeWindowLabel]).toEqual([true, "18:00–00:00"]);
  });

  test("keeps first-signup shift behavior when no target threshold is configured", () => {
    const result = project({
      venue: { openMode: "staffed", timezone: "Europe/Berlin" },
      templates: [shiftTemplate()],
      assignments: [assignment()],
    });

    expect(result.open).toBe(true);
    expect(result.spontaneousOpen).toBe(true);
  });

  test("requires the target count when configured", () => {
    const template = shiftTemplate({ requireTargetForOpening: true });
    const belowTarget = project({
      venue: { openMode: "staffed", timezone: "Europe/Berlin" },
      templates: [template],
      assignments: [assignment()],
    });
    const atTarget = project({
      venue: { openMode: "staffed", timezone: "Europe/Berlin" },
      templates: [template],
      assignments: [assignment(), assignment({ id: "assignment-2", userId: "user-2" })],
    });

    expect(belowTarget.open).toBe(false);
    expect(belowTarget.upcomingOpenings).toHaveLength(0);
    expect(atTarget.open).toBe(true);
  });

  test("includes template-less free assignments as public openings", () => {
    const result = project({
      venue: { openMode: "staffed", timezone: "Europe/Berlin" },
      assignments: [
        assignment({
          templateId: null,
          startsAt: "2026-07-13T11:00:00.000Z",
          endsAt: "2026-07-13T13:00:00.000Z",
        }),
      ],
    });

    expect(result.open).toBe(false);
    expect(result.upcomingOpenings).toEqual([
      {
        kind: "free",
        title: "Additionally open",
        startsAt: "2026-07-13T11:00:00.000Z",
        endsAt: "2026-07-13T13:00:00.000Z",
      },
    ]);
  });

  test("lists a staffed shift under a generic label instead of its internal template title", () => {
    const staffed = {
      venue: { openMode: "staffed" as const, timezone: "Europe/Berlin" },
      templates: [shiftTemplate({ weekday: 2, title: "Early bar crew" })],
      assignments: [assignment({ startsAt: "2026-07-14T08:00:00.000Z", endsAt: "2026-07-14T10:00:00.000Z" })],
    };

    const result = project(staffed);
    expect(result.upcomingOpenings).toEqual([
      { kind: "shift", title: "Additionally open", startsAt: "2026-07-14T08:00:00.000Z", endsAt: "2026-07-14T10:00:00.000Z" },
    ]);
    expect(JSON.stringify(result)).not.toContain("Early bar crew");
    expect(project({ ...staffed, locale: "de" }).upcomingOpenings[0]?.title).toBe("Zusätzlich geöffnet");
  });

  test("opens during an active free assignment without exposing assignment details", () => {
    const result = project({
      assignments: [assignment({ templateId: null })],
    });

    expect(result.open).toBe(true);
    expect(result.spontaneousOpen).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Private volunteer");
    expect(JSON.stringify(result)).not.toContain("Private note");
  });

  test("does not advertise an unstaffed template as a future opening", () => {
    const result = project({
      venue: { openMode: "staffed", timezone: "Europe/Berlin" },
      templates: [shiftTemplate({ weekday: 2 })],
    });

    expect(result.nextOpeningLabel).toBeNull();
    expect(result.upcomingOpenings).toHaveLength(0);
  });

  test("lets a closed override win over regular and staffed openings", () => {
    const result = project({
      openingRules: [openingRule()],
      overrides: [closedOverride()],
      templates: [shiftTemplate()],
      assignments: [assignment()],
    });

    expect(result.open).toBe(false);
    expect(result.todayLabel).toBe("No regular hours today");
  });

  test("derives next opening from the earliest confirmed candidate", () => {
    const result = project({
      openingRules: [openingRule({ weekday: 2, startTime: "09:00", endTime: "11:00" })],
      assignments: [
        assignment({
          templateId: null,
          startsAt: "2026-07-13T16:00:00.000Z",
          endsAt: "2026-07-13T18:00:00.000Z",
        }),
      ],
    });

    expect(result.upcomingOpenings[0]?.kind).toBe("free");
    expect(result.nextOpeningLabel).toContain("Mon");
  });

  test("uses regular hours for the next label without repeating them as dynamic slots", () => {
    const result = project({
      openingRules: [openingRule({ weekday: 2, startTime: "09:00", endTime: "11:00" })],
    });

    expect(result.nextOpeningLabel).toContain("Tue");
    expect(result.upcomingOpenings).toHaveLength(0);
    // The public page's one date format: no zero-padded day.
    const early = project({
      openingRules: [openingRule({ weekday: 2, startTime: "09:00", endTime: "11:00" })],
      now: new Date("2026-09-28T08:30:00.000Z"),
    });
    expect(early.nextOpeningLabel).toBe("Tue, Sep 29, 09:00");
    const german = project({
      openingRules: [openingRule({ weekday: 5, startTime: "09:00", endTime: "11:00" })],
      now: new Date("2026-09-28T08:30:00.000Z"),
      locale: "de",
    });
    expect(german.nextOpeningLabel).toBe("Fr., 2. Okt., 09:00");
  });

  test("formats public availability in the requested locale", () => {
    const result = project({
      locale: "de-CH",
      venue: { openMode: "staffed", timezone: "Europe/Berlin" },
      assignments: [
        assignment({
          templateId: null,
          startsAt: "2026-07-13T11:00:00.000Z",
          endsAt: "2026-07-13T13:00:00.000Z",
        }),
      ],
    });

    expect(result.todayLabel).toBe("Heute keine regelmäßigen Öffnungszeiten");
    expect(result.upcomingOpenings[0]?.title).toBe("Zusätzlich geöffnet");
  });
  test("opens during a special opening instead of the regular hours, in every opening mode", () => {
    const specialOpening: DateOverride = {
      ...closedOverride(),
      kind: "open",
      startTime: "10:00",
      endTime: "12:00",
      note: "Long night",
    };
    for (const openMode of ["regular", "staffed", "combined"] as const) {
      // 10:30 in Berlin: open during the special opening, although the regular hours would start at 11:00.
      const during = project({
        venue: { openMode, timezone: "Europe/Berlin" },
        openingRules: [openingRule({ startTime: "11:00", endTime: "18:00" })],
        overrides: [specialOpening],
        now: new Date("2026-07-13T08:30:00.000Z"),
      });
      expect({ openMode, open: during.open, today: during.todayLabel }).toEqual({ openMode, open: true, today: "10:00–12:00" });

      const after = project({
        venue: { openMode, timezone: "Europe/Berlin" },
        openingRules: [openingRule({ startTime: "11:00", endTime: "18:00" })],
        overrides: [specialOpening],
        now: new Date("2026-07-13T11:00:00.000Z"),
      });
      expect({ openMode, open: after.open }).toEqual({ openMode, open: false });
    }
  });
});

describe("upcomingPublicExceptions", () => {
  const exception = (date: string, kind: DateOverride["kind"], note: string | null = null): DateOverride => ({
    ...closedOverride(),
    id: `override-${date}`,
    date,
    kind,
    startTime: kind === "open" ? "18:00" : null,
    endTime: kind === "open" ? "23:00" : null,
    note,
  });

  test("lists today and the next 29 days in date order, and nothing before or after", () => {
    const result = upcomingPublicExceptions(
      [
        exception("2026-10-13", "closed", "Too late"),
        exception("2026-10-12", "open", "Last day"),
        exception("2026-09-12", "closed", "Yesterday"),
        exception("2026-09-13", "closed", "Today"),
        exception("2026-10-03", "closed", "Public holiday"),
      ],
      "2026-09-13",
      "Europe/Berlin",
    );

    expect(result.map((entry) => [entry.date, entry.note])).toEqual([
      ["2026-09-13", "Today"],
      ["2026-10-03", "Public holiday"],
      ["2026-10-12", "Last day"],
    ]);
  });

  test("keeps times for a special opening and none for a closed day, and never the internal IDs", () => {
    const withStaleTimes: DateOverride = { ...exception("2026-10-03", "closed", "Public holiday"), startTime: "09:00", endTime: "17:00" };
    const result = upcomingPublicExceptions([withStaleTimes, exception("2026-10-17", "open", "Long night")], "2026-09-29", "Europe/Berlin");

    expect(result).toEqual([
      { date: "2026-10-03", kind: "closed", startTime: null, endTime: null, note: "Public holiday" },
      { date: "2026-10-17", kind: "open", startTime: "18:00", endTime: "23:00", note: "Long night" },
    ]);
  });

  test("counts 30 calendar days across the autumn clock change", () => {
    // Berlin leaves summer time on 2026-10-25; the window from 2026-10-01 still ends after 2026-10-30.
    const result = upcomingPublicExceptions(
      [exception("2026-10-30", "closed"), exception("2026-10-31", "closed")],
      "2026-10-01",
      "Europe/Berlin",
    );
    expect(result.map((entry) => entry.date)).toEqual(["2026-10-30"]);
  });

  test("reaches the public availability of a Venue", () => {
    const result = project({ overrides: [exception("2026-07-20", "closed", "Summer break")] });
    expect(result.upcomingExceptions).toEqual([
      { date: "2026-07-20", kind: "closed", startTime: null, endTime: null, note: "Summer break" },
    ]);
  });
});
