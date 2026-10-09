import { describe, expect, test } from "bun:test";
import {
  addCalendarDays,
  defaultTemplateDate,
  describeTemplateDateRule,
  draftFromTemplate,
  formatTemplateDate,
  isoWeek,
  proposeTemplateDates,
  resolveTemplateText,
  type TemplateDraftSource,
} from "./item-templates";

const BERLIN = "Europe/Berlin";

const task = (overrides: Partial<TemplateDraftSource> = {}): TemplateDraftSource => ({
  kind: "task",
  title: "Weekly report {{week}}",
  description: null,
  priority: null,
  assignCreator: false,
  checklist: [],
  estimatedDurationMinutes: null,
  location: null,
  url: null,
  allDay: false,
  durationMinutes: null,
  timeOfDay: null,
  dateRule: { type: "none" },
  tagIds: [],
  assigneeIds: [],
  ...overrides,
});

const event = (overrides: Partial<TemplateDraftSource> = {}): TemplateDraftSource =>
  task({ kind: "event", title: "Standup", ...overrides });

describe("proposeTemplateDates", () => {
  test("weekday sets propose the next matching days across a week boundary", () => {
    // Friday 2026-10-09, 10:00 in Berlin.
    const now = new Date("2026-10-09T08:00:00Z");
    expect(proposeTemplateDates(task({ dateRule: { type: "weekdays", weekdays: ["WE", "TH"] } }), { now, timeZone: BERLIN })).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-21",
    ]);
  });

  test("weekday sets cross month and year boundaries", () => {
    const now = new Date("2026-12-29T08:00:00Z"); // Tuesday
    expect(proposeTemplateDates(task({ dateRule: { type: "weekdays", weekdays: ["FR"] } }), { now, timeZone: BERLIN })).toEqual([
      "2027-01-01",
      "2027-01-08",
      "2027-01-15",
    ]);
    const endOfFebruary = new Date("2027-02-26T20:00:00Z"); // Friday 21:00 in Berlin, after 17:00
    expect(
      proposeTemplateDates(task({ dateRule: { type: "weekdays", weekdays: ["FR", "MO"] } }), { now: endOfFebruary, timeZone: BERLIN }),
    ).toEqual(["2027-03-01", "2027-03-05", "2027-03-08"]);
  });

  test("today counts only while the template time still lies ahead", () => {
    const rule = { type: "weekdays" as const, weekdays: ["WE" as const] };
    // Wednesday 2026-10-14 in Berlin.
    const morning = new Date("2026-10-14T07:00:00Z"); // 09:00
    const evening = new Date("2026-10-14T16:30:00Z"); // 18:30
    expect(proposeTemplateDates(task({ dateRule: rule }), { now: morning, timeZone: BERLIN, count: 1 })).toEqual(["2026-10-14"]);
    expect(proposeTemplateDates(task({ dateRule: rule }), { now: evening, timeZone: BERLIN, count: 1 })).toEqual(["2026-10-21"]);
    expect(proposeTemplateDates(task({ dateRule: rule, timeOfDay: "20:00" }), { now: evening, timeZone: BERLIN, count: 1 })).toEqual([
      "2026-10-14",
    ]);
    // An event starts at 09:00 by default, an all-day event keeps today for the whole day.
    expect(proposeTemplateDates(event({ dateRule: rule }), { now: evening, timeZone: BERLIN, count: 1 })).toEqual(["2026-10-21"]);
    expect(proposeTemplateDates(event({ dateRule: rule, allDay: true }), { now: evening, timeZone: BERLIN, count: 1 })).toEqual([
      "2026-10-14",
    ]);
  });

  test("the person's time zone decides which day today is", () => {
    const now = new Date("2026-10-13T23:30:00Z"); // Wednesday 01:30 in Berlin, Tuesday 19:30 in New York
    const template = task({ dateRule: { type: "weekdays", weekdays: ["TU", "WE"] } });
    expect(proposeTemplateDates(template, { now, timeZone: BERLIN, count: 2 })).toEqual(["2026-10-14", "2026-10-20"]);
    expect(proposeTemplateDates(template, { now, timeZone: "America/New_York", count: 2 })).toEqual(["2026-10-14", "2026-10-20"]);
    expect(proposeTemplateDates(task({ ...template, timeOfDay: "20:00" }), { now, timeZone: "America/New_York", count: 2 })).toEqual([
      "2026-10-13",
      "2026-10-14",
    ]);
    expect(proposeTemplateDates(task({ dateRule: { type: "offset", days: 1 } }), { now, timeZone: BERLIN })).toEqual(["2026-10-15"]);
    expect(proposeTemplateDates(task({ dateRule: { type: "offset", days: 1 } }), { now, timeZone: "America/New_York" })).toEqual([
      "2026-10-14",
    ]);
  });

  test("relative rules propose today plus the offset, including 0 and month ends", () => {
    const now = new Date("2026-01-30T10:00:00Z");
    expect(proposeTemplateDates(task({ dateRule: { type: "offset", days: 0 } }), { now, timeZone: BERLIN })).toEqual(["2026-01-30"]);
    expect(proposeTemplateDates(task({ dateRule: { type: "offset", days: 3 } }), { now, timeZone: BERLIN })).toEqual(["2026-02-02"]);
    expect(proposeTemplateDates(task({ dateRule: { type: "offset", days: 365 } }), { now, timeZone: BERLIN })).toEqual(["2027-01-30"]);
  });

  test("templates without a rule propose nothing", () => {
    expect(proposeTemplateDates(task(), { now: new Date(), timeZone: BERLIN })).toEqual([]);
    expect(defaultTemplateDate(task(), { now: new Date("2026-10-09T08:00:00Z"), timeZone: BERLIN })).toBeNull();
    expect(defaultTemplateDate(event(), { now: new Date("2026-10-09T08:00:00Z"), timeZone: BERLIN })).toBe("2026-10-09");
  });

  test("every weekday proposes consecutive days", () => {
    const now = new Date("2026-10-09T20:00:00Z");
    const rule = { type: "weekdays" as const, weekdays: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const };
    expect(
      proposeTemplateDates(task({ dateRule: { ...rule, weekdays: [...rule.weekdays] } }), { now, timeZone: BERLIN, count: 3 }),
    ).toEqual(["2026-10-10", "2026-10-11", "2026-10-12"]);
  });
});

describe("draftFromTemplate", () => {
  test("a task gets its due time on the chosen local date, also across daylight-saving changes", () => {
    const template = task({ timeOfDay: "09:30" });
    // Berlin leaves summer time on 2026-10-25 and enters it on 2027-03-28.
    expect(draftFromTemplate(template, { date: "2026-10-24", timeZone: BERLIN }).deadline).toBe("2026-10-24T07:30:00.000Z");
    expect(draftFromTemplate(template, { date: "2026-10-26", timeZone: BERLIN }).deadline).toBe("2026-10-26T08:30:00.000Z");
    expect(draftFromTemplate(task(), { date: "2027-03-29", timeZone: BERLIN }).deadline).toBe("2027-03-29T15:00:00.000Z");
    // A time that does not exist on the change day moves forward, as in the item form.
    expect(draftFromTemplate(task({ timeOfDay: "02:30" }), { date: "2027-03-28", timeZone: BERLIN }).deadline).toBe(
      "2027-03-28T01:30:00.000Z",
    );
  });

  test("an event gets start, duration, and all-day bounds in the person's zone", () => {
    const timed = draftFromTemplate(event({ timeOfDay: "10:00", durationMinutes: 90, location: "Room 2" }), {
      date: "2026-10-14",
      timeZone: BERLIN,
    });
    expect(timed).toMatchObject({
      startsAt: "2026-10-14T08:00:00.000Z",
      endsAt: "2026-10-14T09:30:00.000Z",
      allDay: false,
      location: "Room 2",
    });
    expect(draftFromTemplate(event(), { date: "2026-10-14", timeZone: "UTC" })).toMatchObject({
      startsAt: "2026-10-14T09:00:00.000Z",
      endsAt: "2026-10-14T10:00:00.000Z",
    });
    // The all-day bounds follow the zone's midnights, so the day across the change is 25 hours long.
    expect(draftFromTemplate(event({ allDay: true }), { date: "2026-10-25", timeZone: BERLIN })).toMatchObject({
      startsAt: "2026-10-24T22:00:00.000Z",
      endsAt: "2026-10-25T23:00:00.000Z",
      allDay: true,
    });
  });

  test("defaults carry over and kind-foreign fields do not", () => {
    const draft = draftFromTemplate(
      task({
        description: "Due {{weekday}}, {{date}}",
        priority: "high",
        checklist: ["Collect numbers", "Send"],
        estimatedDurationMinutes: 30,
        tagIds: ["Tag001"],
        assigneeIds: ["00000000-0000-4000-8000-000000000001"],
        assignCreator: true,
        location: "ignored",
      }),
      { date: "2026-10-14", timeZone: BERLIN, locale: "de" },
    );
    expect(draft).toEqual({
      title: "Weekly report 42",
      description: "Due Mittwoch, 14.10.2026",
      priority: "high",
      tagIds: ["Tag001"],
      assigneeIds: ["00000000-0000-4000-8000-000000000001"],
      assignCreator: true,
      checklist: ["Collect numbers", "Send"],
      estimatedDurationMinutes: 30,
      deadline: "2026-10-14T15:00:00.000Z",
    });
    expect(draftFromTemplate(event({ checklist: ["x"] }), { date: null, timeZone: BERLIN }).checklist).toEqual([]);
  });

  test("a task without a date has no deadline and fills placeholders with today", () => {
    const draft = draftFromTemplate(task({ title: "Notes {{date}}" }), {
      date: null,
      timeZone: BERLIN,
      locale: "en",
      now: new Date("2026-10-09T08:00:00Z"),
    });
    expect(draft.deadline).toBeUndefined();
    expect(draft.title).toBe("Notes 10/09/2026");
  });
});

describe("placeholders and labels", () => {
  test("placeholders follow the locale; unknown ones stay", () => {
    expect(resolveTemplateText("{{ weekday }} {{date}} KW {{week}} {{name}}", { date: "2026-10-14", locale: "de" })).toBe(
      "Mittwoch 14.10.2026 KW 42 {{name}}",
    );
    expect(resolveTemplateText("{{weekday}} {{date}}", { date: "2026-10-14", locale: "en" })).toBe("Wednesday 10/14/2026");
  });

  test("ISO weeks wrap at the year boundary", () => {
    expect(isoWeek("2026-12-31")).toBe(53);
    expect(isoWeek("2027-01-01")).toBe(53);
    expect(isoWeek("2027-01-04")).toBe(1);
    expect(isoWeek("2024-12-30")).toBe(1);
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  test("proposal chips and rule summaries are short and localized", () => {
    expect(formatTemplateDate("2026-10-14", "de")).toBe("Mi 14.10.");
    expect(formatTemplateDate("2026-10-14", "en")).toBe("Wed 10/14");
    expect(describeTemplateDateRule(task({ dateRule: { type: "weekdays", weekdays: ["TH", "WE"] } }), "de")).toBe("Mi oder Do · 17:00");
    expect(describeTemplateDateRule(event({ dateRule: { type: "offset", days: 3 }, allDay: true }), "en")).toBe("In 3 days · all day");
    expect(describeTemplateDateRule(task({ dateRule: { type: "offset", days: 0 }, timeOfDay: "08:15" }), "de")).toBe("Heute · 08:15");
    expect(describeTemplateDateRule(task(), "de")).toBe("Ohne Datum");
  });
});
