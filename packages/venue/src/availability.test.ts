// fallow-ignore-file unused-file
import { describe, expect, test } from "bun:test";
import { buildPublicAvailability } from "./availability";
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
  test("opens during regular hours", () => {
    const result = project({ openingRules: [openingRule()] });

    expect(result.open).toBe(true);
    expect(result.spontaneousOpen).toBe(false);
    expect(result.todayLabel).toBe("09:00-17:00");
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
        title: "Additional opening",
        startsAt: "2026-07-13T11:00:00.000Z",
        endsAt: "2026-07-13T13:00:00.000Z",
      },
    ]);
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
    expect(result.upcomingOpenings[0]?.title).toBe("Zusätzliche Öffnung");
  });
});
