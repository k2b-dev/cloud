import { describe, expect, test } from "bun:test";
import {
  expandRecurringEvents,
  parseRecurrenceRule,
  resolveRecurringOccurrence,
  shiftRecurrenceRule,
  splitRecurringEvent,
} from "./recurrence";

const baseEvent = {
  id: "weekly",
  title: "Weekly planning",
  start: "2026-05-04T09:00:00.000Z",
  end: "2026-05-04T10:30:00.000Z",
};

describe("parseRecurrenceRule", () => {
  test("parses common RFC 5545 recurrence parts", () => {
    expect(parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5")).toEqual({
      freq: "WEEKLY",
      interval: 2,
      count: 5,
      byDay: [1, 3],
      until: undefined,
    });
  });

  test("rejects unsupported or invalid rules", () => {
    expect(() => parseRecurrenceRule("FREQ=HOURLY")).toThrow("Recurrence rule requires");
    expect(() => parseRecurrenceRule("FREQ=DAILY;INTERVAL=0")).toThrow("INTERVAL");
    expect(() => parseRecurrenceRule("FREQ=DAILY;COUNT=0")).toThrow("COUNT");
    expect(() => parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO,NOPE")).toThrow("BYDAY");
    expect(() => parseRecurrenceRule("FREQ=DAILY;UNTIL=not-a-date")).toThrow("UNTIL");
    expect(() => parseRecurrenceRule("FREQ=DAILY;UNTIL=20260231T090000Z")).toThrow("UNTIL");
    expect(() => parseRecurrenceRule("FREQ=DAILY;BYDAY=MO")).toThrow("weekly");
    expect(() => parseRecurrenceRule("FREQ=DAILY;BYMONTHDAY=2")).toThrow("not supported");
    expect(() => parseRecurrenceRule("FREQ=DAILY;COUNT")).toThrow("invalid part");
  });
});

test("moved overrides disappear from the original window and appear exactly once in the destination window", () => {
  const events = [
    {
      id: "series",
      title: "Original",
      start: "2026-01-01T09:00:00Z",
      end: "2026-01-01T10:00:00Z",
      recurrence: { rrule: "FREQ=DAILY;COUNT=1" },
    },
  ];
  const overrides = [
    {
      id: "override",
      recurringEventId: "series",
      recurrenceId: "2026-01-01T09:00:00Z",
      title: "Moved",
      start: "2026-01-02T09:00:00Z",
      end: "2026-01-02T10:00:00Z",
    },
  ];
  expect(expandRecurringEvents({ events, overrides, rangeStart: "2026-01-01T00:00:00Z", rangeEnd: "2026-01-02T00:00:00Z" })).toEqual([]);
  expect(
    expandRecurringEvents({ events, overrides, rangeStart: "2026-01-02T00:00:00Z", rangeEnd: "2026-01-03T00:00:00Z" }).map(
      (item) => item.id,
    ),
  ).toEqual(["override"]);
  expect(
    expandRecurringEvents({ events, overrides, rangeStart: "2026-01-01T00:00:00Z", rangeEnd: "2026-01-03T00:00:00Z" }).map(
      (item) => item.id,
    ),
  ).toEqual(["override"]);
  expect(() =>
    expandRecurringEvents({
      events,
      overrides,
      rangeStart: "2026-01-02T00:00:00Z",
      rangeEnd: "2026-01-03T00:00:00Z",
      expansionLimit: 1,
      requireComplete: true,
    }),
  ).toThrow("Recurrence budget exceeded");
});

describe("expandRecurringEvents", () => {
  test("expands daily series and preserves duration", () => {
    const events = expandRecurringEvents({
      events: [{ ...baseEvent, recurrence: { rrule: "FREQ=DAILY;COUNT=3" } }],
      rangeStart: "2026-05-04T00:00:00.000Z",
      rangeEnd: "2026-05-08T00:00:00.000Z",
    });

    expect(events.map((event) => event.start)).toEqual([
      "2026-05-04T09:00:00.000Z",
      "2026-05-05T09:00:00.000Z",
      "2026-05-06T09:00:00.000Z",
    ]);
    expect(events[0]?.end).toBe("2026-05-04T10:30:00.000Z");
  });

  test("expands weekly BYDAY series inside the requested range", () => {
    const events = expandRecurringEvents({
      events: [{ ...baseEvent, recurrence: { rrule: "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4" } }],
      rangeStart: "2026-05-04T00:00:00.000Z",
      rangeEnd: "2026-05-14T00:00:00.000Z",
    });

    expect(events.map((event) => event.start)).toEqual([
      "2026-05-04T09:00:00.000Z",
      "2026-05-06T09:00:00.000Z",
      "2026-05-11T09:00:00.000Z",
      "2026-05-13T09:00:00.000Z",
    ]);
  });

  test("expands custom weekly interval with selected weekdays", () => {
    const events = expandRecurringEvents({
      events: [{ ...baseEvent, recurrence: { rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=4" } }],
      rangeStart: "2026-05-04T00:00:00.000Z",
      rangeEnd: "2026-06-01T00:00:00.000Z",
    });

    expect(events.map((event) => event.start)).toEqual([
      "2026-05-04T09:00:00.000Z",
      "2026-05-08T09:00:00.000Z",
      "2026-05-18T09:00:00.000Z",
      "2026-05-22T09:00:00.000Z",
    ]);
  });

  test("honors UNTIL, EXDATE, and overrides", () => {
    const events = expandRecurringEvents({
      events: [
        {
          ...baseEvent,
          recurrence: {
            rrule: "FREQ=DAILY;UNTIL=20260507T090000Z",
            exdate: ["2026-05-05T09:00:00.000Z"],
          },
        },
      ],
      overrides: [
        {
          ...baseEvent,
          id: "weekly-override",
          title: "Weekly planning moved",
          start: "2026-05-06T14:00:00.000Z",
          end: "2026-05-06T15:30:00.000Z",
          recurringEventId: "weekly",
          recurrenceId: "2026-05-06T09:00:00.000Z",
        },
      ],
      rangeStart: "2026-05-04T00:00:00.000Z",
      rangeEnd: "2026-05-09T00:00:00.000Z",
    });

    expect(events.map((event) => [event.id, event.title, event.start])).toEqual([
      ["weekly:2026-05-04T09:00:00.000Z", "Weekly planning", "2026-05-04T09:00:00.000Z"],
      ["weekly-override", "Weekly planning moved", "2026-05-06T14:00:00.000Z"],
      ["weekly:2026-05-07T09:00:00.000Z", "Weekly planning", "2026-05-07T09:00:00.000Z"],
    ]);
  });

  test("caps unbounded recurrence expansion", () => {
    const events = expandRecurringEvents({
      events: [{ ...baseEvent, recurrence: { rrule: "FREQ=DAILY" } }],
      rangeStart: "2026-05-04T00:00:00.000Z",
      rangeEnd: "2026-06-04T00:00:00.000Z",
      expansionLimit: 5,
    });

    expect(events).toHaveLength(5);
  });

  test("keeps expanding later series after one series ends", () => {
    const events = expandRecurringEvents({
      events: [
        { ...baseEvent, id: "short", recurrence: { rrule: "FREQ=DAILY;COUNT=1" } },
        {
          ...baseEvent,
          id: "later",
          start: "2026-05-06T12:00:00.000Z",
          end: "2026-05-06T13:00:00.000Z",
          recurrence: { rrule: "FREQ=DAILY;COUNT=2" },
        },
      ],
      rangeStart: "2026-05-04T00:00:00.000Z",
      rangeEnd: "2026-05-09T00:00:00.000Z",
    });

    expect(events.map((event) => event.id)).toEqual([
      "short:2026-05-04T09:00:00.000Z",
      "later:2026-05-06T12:00:00.000Z",
      "later:2026-05-07T12:00:00.000Z",
    ]);
  });
});

describe("resolveRecurringOccurrence", () => {
  test("resolves an included occurrence and rejects excluded or invented instants", () => {
    const event = {
      id: "daily",
      title: "Daily stand-up",
      start: "2026-07-01T09:00:00.000Z",
      end: "2026-07-01T09:30:00.000Z",
      recurrence: {
        rrule: "FREQ=DAILY;COUNT=4",
        dtstart: "2026-07-01T09:00:00.000Z",
        exdate: ["2026-07-03T09:00:00.000Z"],
      },
    };

    expect(resolveRecurringOccurrence({ event, recurrenceId: "2026-07-02T09:00:00.000Z" })).toEqual({
      recurrenceId: "2026-07-02T09:00:00.000Z",
      start: "2026-07-02T09:00:00.000Z",
      end: "2026-07-02T09:30:00.000Z",
      allDay: false,
    });
    expect(resolveRecurringOccurrence({ event, recurrenceId: "2026-07-03T09:00:00.000Z" })).toBeNull();
    expect(resolveRecurringOccurrence({ event, recurrenceId: "2026-07-02T10:00:00.000Z" })).toBeNull();
    expect(
      resolveRecurringOccurrence({
        event: { ...event, recurrence: { ...event.recurrence, rrule: "FREQ=DAILY;UNTIL=not-a-date" } },
        recurrenceId: "2026-07-02T09:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("resolves established daily series beyond the calendar expansion page size", () => {
    const event = {
      id: "long-running",
      title: "Daily check",
      start: "2020-01-01T09:00:00.000Z",
      end: "2020-01-01T09:15:00.000Z",
      recurrence: { rrule: "FREQ=DAILY" },
    };

    expect(resolveRecurringOccurrence({ event, recurrenceId: "2027-01-01T09:00:00.000Z" })?.start).toBe("2027-01-01T09:00:00.000Z");
  });
});

describe("recurrence series changes", () => {
  test("moves an absolute UNTIL boundary with the series", () => {
    expect(shiftRecurrenceRule("FREQ=DAILY;COUNT=4;UNTIL=20260710T090000Z", 60 * 60 * 1000)).toBe(
      "FREQ=DAILY;COUNT=4;UNTIL=20260710T100000Z",
    );
    expect(shiftRecurrenceRule("FREQ=DAILY;COUNT=4", 60 * 60 * 1000)).toBe("FREQ=DAILY;COUNT=4");
  });

  test("splits COUNT, UNTIL, and exceptions around the selected occurrence", () => {
    const event = {
      id: "daily",
      title: "Daily stand-up",
      start: "2026-07-01T09:00:00.000Z",
      end: "2026-07-01T09:30:00.000Z",
      recurrence: {
        rrule: "FREQ=DAILY;COUNT=6;UNTIL=20260710T090000Z",
        dtstart: "2026-07-01T09:00:00.000Z",
        exdate: ["2026-07-02T09:00:00.000Z", "2026-07-05T09:00:00.000Z"],
      },
    };

    expect(
      splitRecurringEvent({
        event,
        recurrenceId: "2026-07-04T09:00:00.000Z",
        nextStart: "2026-07-04T10:00:00.000Z",
      }),
    ).toEqual({
      isFirstOccurrence: false,
      previousRrule: "FREQ=DAILY;UNTIL=20260704T085959Z",
      previousExdate: ["2026-07-02T09:00:00.000Z"],
      nextRrule: "FREQ=DAILY;UNTIL=20260710T100000Z;COUNT=3",
      nextExdate: ["2026-07-05T10:00:00.000Z"],
    });
  });

  test("rejects an excluded split occurrence", () => {
    expect(
      splitRecurringEvent({
        event: {
          ...baseEvent,
          recurrence: {
            rrule: "FREQ=DAILY",
            exdate: ["2026-05-05T09:00:00.000Z"],
          },
        },
        recurrenceId: "2026-05-05T09:00:00.000Z",
        nextStart: "2026-05-05T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  test("identifies a split at the first occurrence", () => {
    expect(
      splitRecurringEvent({
        event: {
          ...baseEvent,
          recurrence: { rrule: "FREQ=DAILY;COUNT=2" },
        },
        recurrenceId: baseEvent.start,
        nextStart: "2026-05-04T10:00:00.000Z",
      })?.isFirstOccurrence,
    ).toBe(true);
  });
});
