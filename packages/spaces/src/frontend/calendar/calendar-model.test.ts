import { describe, expect, test } from "bun:test";
import {
  CALENDAR_REQUEST_DAYS,
  type CalendarSourceView,
  calendarLookup,
  calendarStatus,
  cloudCalendarHref,
  defaultSelection,
  mergeItems,
  nextBlock,
  normalizeSelection,
  parseCloudCalendarRoute,
  requestBatches,
  requestRanges,
  type SourcedCalendarItem,
  splitCalendarKey,
  toCalendarEvent,
  viewWindow,
} from "./calendar-model";
import { calendarViewMessages } from "./messages";

const dateConfig = { timeZone: "Europe/Berlin", locale: "de", weekStartsOn: 1 as const };
const t = calendarViewMessages.resolve(["de"]).t;
const DAY = 86_400_000;
const sources: CalendarSourceView[] = [
  {
    appId: "spaces",
    name: "Spaces",
    icon: null,
    state: "ok",
    error: null,
    calendars: [
      { id: "Space1", name: "Team", color: "#8b5cf6", suggested: true, visibility: "details", writable: false },
      { id: "Space2", name: "Public", color: "#3b82f6", suggested: false, visibility: "details", writable: false },
    ],
  },
  {
    appId: "meetings",
    name: "Meetings",
    icon: null,
    state: "ok",
    error: null,
    calendars: [{ id: "board:a", name: "Board", suggested: false, visibility: "busy", writable: false }],
  },
];
const event = (id: string, start: string, end: string, calendarId = "Space1"): SourcedCalendarItem => ({
  type: "event",
  appId: "spaces",
  calendarId,
  id,
  title: id,
  time: { kind: "instant", start, end, timeZone: "Europe/Berlin" },
  location: null,
  status: "confirmed",
  transparency: "busy",
  occurrence: null,
  ref: null,
  open: null,
  version: "1",
});

describe("calendar route", () => {
  test("reads view, date, and the chosen calendars, falling back to the week of today", () => {
    const route = parseCloudCalendarRoute(
      new URL("http://x/app/spaces/calendar?view=month&date=2026-10-27&cal=spaces:Space1&cal=meetings:board:a&cal=bad"),
      dateConfig,
    );
    expect(route).toEqual({ view: "month", date: "2026-10-27", selection: ["spaces:Space1", "meetings:board:a"] });
    expect(parseCloudCalendarRoute(new URL("http://x/app/spaces/calendar?view=year&date=27.10."), dateConfig).view).toBe("week");
    expect(parseCloudCalendarRoute(new URL("http://x/app/spaces/calendar"), dateConfig).selection).toBeNull();
    expect(parseCloudCalendarRoute(new URL("http://x/app/spaces/calendar?cal="), dateConfig).selection).toEqual([]);
  });

  test("a calendar ID keeps its colons; the app ID ends at the first", () => {
    expect(splitCalendarKey("meetings:board:a")).toEqual({ appId: "meetings", calendarId: "board:a" });
    expect(splitCalendarKey(":x")).toBeNull();
    expect(splitCalendarKey("spaces:")).toBeNull();
  });

  test("the URL names a changed choice only, and none as an empty value", () => {
    expect(defaultSelection(sources)).toEqual(["spaces:Space1"]);
    expect(normalizeSelection(["spaces:Space1"], sources)).toBeNull();
    expect(normalizeSelection([], sources)).toEqual([]);
    expect(cloudCalendarHref({ view: "week", date: "2026-10-27", selection: null })).toBe("/app/spaces/calendar?view=week&date=2026-10-27");
    expect(cloudCalendarHref({ view: "day", date: "2026-10-27", selection: [] })).toBe(
      "/app/spaces/calendar?view=day&date=2026-10-27&cal=",
    );
    const href = cloudCalendarHref({ view: "list", date: "2026-10-27", selection: ["meetings:board:a"] });
    expect(parseCloudCalendarRoute(new URL(href, "http://x"), dateConfig).selection).toEqual(["meetings:board:a"]);
  });
});

describe("ranges", () => {
  test("every first load fits one request of six weeks, also across the clock change", () => {
    for (const view of ["day", "week", "month", "list"] as const) {
      const range = viewWindow(view, "2026-10-27", dateConfig);
      const days = (Date.parse(range.to) - Date.parse(range.from)) / DAY;
      expect(days).toBeLessThanOrEqual(CALENDAR_REQUEST_DAYS + 1 / 24);
      expect(days).toBeGreaterThan(0);
    }
    // The week of October 27 starts Monday the 26th; it loads the week before and the two after.
    expect(viewWindow("week", "2026-10-27", dateConfig)).toEqual({ from: "2026-10-18T22:00:00.000Z", to: "2026-11-15T23:00:00.000Z" });
    expect(viewWindow("month", "2026-10-27", dateConfig).from).toBe("2026-09-27T22:00:00.000Z");
  });

  test("blocks grow the loaded days and stop after a year", () => {
    const range = viewWindow("week", "2026-10-27", dateConfig);
    expect(nextBlock(range, "later", "week", dateConfig)).toEqual({ from: range.to, to: "2026-11-22T23:00:00.000Z" });
    expect(nextBlock(range, "earlier", "month", dateConfig)?.to).toBe(range.from);
    expect(nextBlock(range, "later", "list", dateConfig)).toBeNull();
    expect(nextBlock({ from: "2026-01-01T00:00:00.000Z", to: "2026-12-30T00:00:00.000Z" }, "later", "week", dateConfig)).toBeNull();
  });

  test("the month across the clock change becomes two requests the route accepts", () => {
    const month = viewWindow("month", "2026-10-27", dateConfig);
    expect(Date.parse(month.to) - Date.parse(month.from)).toBe(CALENDAR_REQUEST_DAYS * DAY + 3_600_000);
    const parts = requestRanges(month, dateConfig);
    expect(parts.length).toBe(2);
    for (const part of parts) expect(Date.parse(part.to) - Date.parse(part.from)).toBeLessThanOrEqual(CALENDAR_REQUEST_DAYS * DAY);
    expect(parts[0]!.from).toBe(month.from);
    expect(parts[1]!.to).toBe(month.to);
    expect(requestBatches(Array.from({ length: 205 }, (_, index) => `spaces:S${index}`)).map((batch) => batch.length)).toEqual([
      100, 100, 5,
    ]);
  });

  test("a refresh splits the loaded days into requests of at most six weeks without gaps", () => {
    const parts = requestRanges({ from: "2026-09-27T22:00:00.000Z", to: "2027-01-03T23:00:00.000Z" }, dateConfig);
    expect(parts[0]!.from).toBe("2026-09-27T22:00:00.000Z");
    expect(parts.at(-1)!.to).toBe("2027-01-03T23:00:00.000Z");
    for (const [index, part] of parts.entries()) {
      expect(Date.parse(part.to) - Date.parse(part.from)).toBeLessThanOrEqual(CALENDAR_REQUEST_DAYS * DAY);
      if (index > 0) expect(part.from).toBe(parts[index - 1]!.to);
    }
  });
});

describe("items", () => {
  test("a fresh read replaces what it covered for its calendars and keeps the rest once", () => {
    const current = [
      event("old", "2026-10-27T08:00:00Z", "2026-10-27T09:00:00Z"),
      event("kept", "2026-11-27T08:00:00Z", "2026-11-27T09:00:00Z"),
      event("other", "2026-10-27T08:00:00Z", "2026-10-27T09:00:00Z", "Space2"),
    ];
    const merged = mergeItems(
      current,
      [event("kept", "2026-11-27T08:00:00Z", "2026-11-27T09:00:00Z"), event("new", "2026-10-28T08:00:00Z", "2026-10-28T09:00:00Z")],
      { range: { from: "2026-10-26T00:00:00Z", to: "2026-11-02T00:00:00Z" }, calendars: new Set(["spaces:Space1"]) },
      dateConfig,
    );
    expect(merged.map((item) => item.id).sort()).toEqual(["kept", "new", "other"]);
  });

  test("opaque IDs with colons never collide", () => {
    const one = { ...event("c", "2026-10-27T08:00:00Z", "2026-10-27T09:00:00Z", "a:b") };
    const two = { ...event("b:c", "2026-10-27T08:00:00Z", "2026-10-27T09:00:00Z", "a") };
    const merged = mergeItems([], [one, two], {
      range: { from: "2026-10-26T00:00:00Z", to: "2026-10-28T00:00:00Z" },
      calendars: new Set(),
    });
    expect(merged.length).toBe(2);
  });

  test("busy time carries no detail, deadlines are markers, dates stay dates", () => {
    const lookup = calendarLookup(sources);
    const busy = toCalendarEvent(
      {
        type: "busy",
        appId: "meetings",
        calendarId: "board:a",
        id: "b1",
        time: { kind: "instant", start: "2026-10-27T13:00:00Z", end: "2026-10-27T14:00:00Z", timeZone: null },
        status: "confirmed",
        transparency: "busy",
      },
      lookup,
      t,
    );
    expect(busy).toMatchObject({ title: "Belegt", colorHex: "#71717a", calendarName: "Meetings · Board" });
    const deadline = toCalendarEvent(
      {
        type: "deadline",
        appId: "spaces",
        calendarId: "Space1",
        id: "d1",
        title: "Report",
        due: { kind: "date", date: "2026-10-31" },
        done: true,
        occurrence: null,
        ref: null,
        open: null,
        version: "1",
      },
      lookup,
      t,
    );
    expect(deadline).toMatchObject({ display: "marker", allDay: true, start: "2026-10-31", end: "2026-11-01", checked: true });
    expect(deadline.accessibleDetail).toContain("Erledigt");
  });
});

describe("status", () => {
  const selection = ["spaces:Space1", "meetings:board:a"];
  const reads = (spaces: string, meetings: string) =>
    new Map([
      ["spaces:Space1", { appId: "spaces", state: spaces, error: null }],
      ["meetings:board:a", { appId: "meetings", state: meetings, error: null }],
    ] as never);
  test("loading comes first, then a failure, then busy-only calendars", () => {
    expect(calendarStatus(selection, sources, reads("ok", "pending"))).toEqual({ kind: "loading", count: 1, total: 2 });
    expect(calendarStatus(selection, sources, reads("failed", "ok"))).toEqual({ kind: "failed", apps: ["Spaces"], count: 1 });
    expect(calendarStatus(selection, sources, reads("ok", "truncated"))).toEqual({ kind: "truncated" });
    expect(calendarStatus(selection, sources, reads("ok", "ok"))).toEqual({ kind: "busy", names: ["Meetings · Board"] });
    expect(calendarStatus(["spaces:Space1"], sources, reads("ok", "ok"))).toBeNull();
  });

  test("a failed calendar stays failed when another calendar of its app answers", () => {
    const states = new Map([
      ["spaces:Space1", { appId: "spaces", state: "failed" as const, error: null }],
      ["spaces:Space2", { appId: "spaces", state: "ok" as const, error: null }],
    ]);
    expect(calendarStatus(["spaces:Space1", "spaces:Space2"], sources, states)).toEqual({ kind: "failed", apps: ["Spaces"], count: 1 });
  });

  test("a source that could not list its calendars counts as failed", () => {
    const broken: CalendarSourceView[] = [
      ...sources,
      { appId: "absence", name: "Abwesenheiten", icon: null, state: "failed", error: null, calendars: [] },
    ];
    expect(
      calendarStatus(["spaces:Space1"], broken, new Map([["spaces:Space1", { appId: "spaces", state: "ok" as const, error: null }]])),
    ).toEqual({ kind: "failed", apps: ["Abwesenheiten"], count: 1 });
  });
});
