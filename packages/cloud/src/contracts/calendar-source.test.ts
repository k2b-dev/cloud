import { expect, test, spyOn } from "bun:test";
import { capabilityHash, compileCapabilities, resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { resolveLiveCapabilityRegistryEntry } from "../_internal/registry";
import { compileCapabilityManifest } from "../capabilities/testing";
import { type CapabilityDefinitions, CapabilityManifestSchema } from "./capabilities";
import * as calendar from "./calendar-source";

const run = async () => ({ ok: false as const, error: { code: "INTERNAL", message: "Unused", status: 500 as const } });
const definitions = (): CapabilityDefinitions => ({
  protocolVersion: 2,
  queries: {
    calendars: {
      title: "Calendars",
      description: "List calendars",
      input: calendar.CalendarListInputSchema,
      data: calendar.CalendarListDataSchema,
      openWorld: false,
      run,
    },
    events: {
      title: "Events",
      description: "Read events",
      input: calendar.CalendarEventsInputSchema,
      data: calendar.CalendarEventsDataSchema,
      openWorld: false,
      run,
    },
  },
  actions: {
    update: {
      title: "Update",
      description: "Update item",
      input: calendar.CalendarUpdateInputSchema,
      data: calendar.CalendarUpdateDataSchema,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      run,
    },
    move: {
      title: "Move",
      description: "Move item",
      input: calendar.CalendarMoveInputSchema,
      data: calendar.CalendarMoveDataSchema,
      openWorld: false,
      destructive: false,
      idempotency: "required",
      run,
    },
    delete: {
      title: "Delete",
      description: "Delete item",
      input: calendar.CalendarDeleteInputSchema,
      data: calendar.CalendarDeleteDataSchema,
      openWorld: false,
      destructive: true,
      idempotency: "required",
      review: run,
      run,
    },
  },
  calendarSource: { calendars: "calendars", events: "events", update: "update", move: "move", delete: "delete" },
});

test("calendar sources compile read-only or with all reserved writes", () => {
  const manifest = compileCapabilityManifest("calendar", definitions());
  expect(calendar.calendarSourceIssues(manifest)).toEqual([]);
  expect(
    compileCapabilityManifest("calendar", { ...definitions(), calendarSource: { calendars: "calendars", events: "events" } })
      .calendarSource,
  ).toEqual({ calendars: "calendars", events: "events" });
  expect(resolveCapabilityManifestPresentation(manifest, undefined, "de").calendarSource).toEqual(manifest.calendarSource);
  const { calendarSource: _source, ...plain } = definitions();
  const without = compileCapabilityManifest("calendar", plain);
  expect(without).not.toHaveProperty("calendarSource");
  expect(compileCapabilityManifest("calendar", { ...plain, calendarSource: undefined })).toEqual(without);
});

test("startup refuses missing, wrong-kind, streaming, open-world and non-idempotent operations", () => {
  for (const name of calendar.CALENDAR_SOURCE_FUNCTIONS) {
    expect(() =>
      compileCapabilities("calendar", { ...definitions(), calendarSource: { ...definitions().calendarSource!, [name]: "missing" } }),
    ).toThrow("No Query or Action named missing");
  }
  const valid = compileCapabilityManifest("calendar", definitions());
  for (const [name, localId] of [
    ["events", "update"],
    ["move", "events"],
  ]) {
    expect(
      calendar
        .calendarSourceIssues({ ...valid, calendarSource: { ...valid.calendarSource!, [name!]: localId! } })
        .some((issue) => issue.code === "kind"),
    ).toBe(true);
  }
  const invalid = structuredClone(valid);
  invalid.actions.find((action) => action.localId === "move")!.idempotency = "none";
  invalid.actions.find((action) => action.localId === "delete")!.destructive = false;
  invalid.queries[0]!.openWorld = true;
  invalid.queries[1]!.stream = { direction: "read", maxBytes: 10 };
  expect(calendar.calendarSourceIssues(invalid).map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["kind", "stream", "idempotency"]),
  );
  expect(calendar.calendarSourceIssues({ ...valid, calendarSource: undefined })).toEqual([]);
});

test("unreadable calendar declarations drop as a whole without affecting other capabilities or sent hashes", () => {
  const manifest = compileCapabilityManifest("calendar", definitions());
  for (const declaration of [
    { ...manifest.calendarSource, subscribe: "subscribe" },
    { ...manifest.calendarSource, update: 1 },
  ]) {
    const read = CapabilityManifestSchema.parse({ ...manifest, calendarSource: declaration });
    expect(read).not.toHaveProperty("calendarSource");
    expect(read.queries).toEqual(manifest.queries);
    expect(read.manifestHash).toBe(manifest.manifestHash);
  }
});

test("registry ignores incompatible declarations and logs once per manifest", () => {
  const manifest = compileCapabilityManifest("calendar-test", definitions());
  manifest.calendarSource!.events = "missing";
  const { manifestHash: _hash, ...base } = manifest;
  manifest.manifestHash = capabilityHash(base);
  const app = {
    id: manifest.appId,
    name: "Calendar",
    icon: "ti ti-calendar",
    description: "Calendar",
    baseUrl: "http://calendar:3000",
    routes: ["/app/calendar"],
    capabilities: { protocolVersion: 2, manifestHash: manifest.manifestHash },
  };
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (let count = 0; count < 3; count++) {
      const entry = resolveLiveCapabilityRegistryEntry(`capabilities/${manifest.appId}`, { appId: manifest.appId, manifest }, app);
      expect(entry?.manifest).not.toHaveProperty("calendarSource");
      expect(entry?.manifest.queries).toEqual(manifest.queries);
    }
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

test("range, limit, dates, deadlines and write inputs enforce the calendar contract", () => {
  const input = { calendarIds: ["a"], from: "2026-03-01T00:00:00Z", to: "2026-04-01T00:00:00Z" };
  expect(calendar.CalendarEventsInputSchema.safeParse(input).success).toBe(true);
  for (const change of [
    { to: input.from },
    { to: "2026-04-01T00:00:01Z" },
    { limit: 0 },
    { limit: 101 },
    { calendarIds: [] },
    { from: "2026-03-01T00:00:00" },
  ]) {
    expect(calendar.CalendarEventsInputSchema.safeParse({ ...input, ...change }).success).toBe(false);
  }
  expect(calendar.CalendarEventTimeSchema.safeParse({ kind: "date", start: "2026-01-01", end: "2026-01-01" }).success).toBe(false);
  expect(calendar.CalendarDueTimeSchema.safeParse({ kind: "date", date: "2026-02-30" }).success).toBe(false);
  expect(calendar.CalendarDueTimeSchema.safeParse({ kind: "instant", at: input.from, timeZone: "Europe/Berlin" }).success).toBe(true);
  const write = { calendarId: "a", id: "i", version: "v" };
  expect(calendar.CalendarMoveInputSchema.safeParse(write).success).toBe(false);
  const time = { kind: "date", start: "2026-01-01", end: "2026-01-02" };
  const due = { kind: "date", date: "2026-01-01" };
  expect(calendar.CalendarMoveInputSchema.safeParse({ ...write, time, due }).success).toBe(false);
  expect(calendar.CalendarMoveInputSchema.safeParse({ ...write, time: { ...time, extra: true } }).success).toBe(false);
  expect(calendar.CalendarMoveInputSchema.safeParse({ ...write, due }).success).toBe(true);
  expect(
    calendar.CalendarItemSchema.safeParse({
      type: "deadline",
      id: "i",
      calendarId: "a",
      due,
      title: "Task",
      done: false,
      occurrence: null,
      ref: null,
      open: null,
      version: "v",
    }).success,
  ).toBe(true);
});

test("reader projection retains no extra or private busy fields, including nested fields", () => {
  const raw = {
    type: "busy",
    id: "i",
    calendarId: "a",
    time: { kind: "instant", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z", timeZone: null, secret: "private" },
    status: "confirmed",
    transparency: "busy",
    title: "Private",
    location: "Secret",
    ref: { type: "x.y", id: "z" },
    open: { rel: "open", href: "/secret" },
    version: "v",
    occurrence: { seriesId: "private" },
  };
  expect(calendar.projectCalendarItem(calendar.CalendarItemSchema.parse(raw))).toEqual({
    type: "busy",
    id: "i",
    calendarId: "a",
    time: { kind: "instant", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z", timeZone: null },
    status: "confirmed",
    transparency: "busy",
  });
});
