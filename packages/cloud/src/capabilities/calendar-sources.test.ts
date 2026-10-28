import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  CalendarEventsDataSchema,
  CalendarEventsInputSchema,
  CalendarListDataSchema,
  CalendarListInputSchema,
} from "../contracts/calendar-source";
import { listCalendarSources, readCalendarEvents } from "./calendar-sources";
import type { CapabilityCaller } from "./server";
import { compileCapabilityManifest } from "./testing";

const now = Date.parse("2026-03-20T12:00:00Z");
const oldOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
beforeEach(() => {
  setSystemTime(new Date(now));
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://calendar.test";
});
afterEach(() => {
  setSystemTime();
  if (oldOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = oldOrigin;
});
const unused = async () => ({ ok: true as const, data: { data: { items: [], next: null } } });
const app = (appId: string) => ({
  appId,
  appName: `Calendar ${appId}`,
  appIcon: "ti ti-calendar",
  appDescription: "Calendar",
  manifest: compileCapabilityManifest(appId, {
    protocolVersion: 2,
    queries: {
      calendars: {
        title: "Calendars",
        description: "List calendars",
        input: CalendarListInputSchema,
        data: CalendarListDataSchema,
        openWorld: false,
        run: unused,
      },
      events: {
        title: "Events",
        description: "Read events",
        input: CalendarEventsInputSchema,
        data: CalendarEventsDataSchema,
        openWorld: false,
        run: unused,
      },
    },
    calendarSource: { calendars: "calendars", events: "events" },
  }),
});
const busy = {
  type: "busy",
  id: "event",
  calendarId: "cal",
  time: { kind: "instant", start: "2026-03-25T10:00:00Z", end: "2026-04-25T12:00:00Z", timeZone: "Europe/Berlin" },
  status: "confirmed",
  transparency: "busy",
} as const;
const range = { from: "2026-03-20T00:00:00+01:00", to: "2026-05-01T01:00:00+02:00" };
const shortRange = { from: "2026-03-20T00:00:00Z", to: "2026-03-21T00:00:00Z" };
const json = (body: unknown, status = 200) => Response.json(body, { status });
type Call = { appId: string; operation: string; input: Record<string, unknown>; signal: AbortSignal };
const transport = (ids: string[], run: (call: Call) => Promise<Response> | Response): CapabilityCaller => ({
  cookie: "session=test",
  authorization: "Bearer test",
  requestId: "calendar-request",
  locale: "de",
  transport: async (request) => {
    expect(request.headers.get("cookie")).toBe("session=test");
    expect(request.headers.get("authorization")).toBe("Bearer test");
    expect(request.headers.get("x-request-id")).toBe("calendar-request");
    expect(request.headers.get("x-cloud-locale")).toBe("de");
    const url = new URL(request.url);
    if (url.pathname.endsWith("/catalog")) return json({ protocolVersion: 2, apps: ids.map(app), page: { hasMore: false } });
    const parts = url.pathname.split("/");
    return run({ appId: parts.at(-2)!, operation: parts.at(-1)!, input: (await request.json()).input, signal: request.signal });
  },
});
const events = (credentials: CapabilityCaller, overrides: Partial<Parameters<typeof readCalendarEvents>[0]> = {}) =>
  readCalendarEvents({
    credentials,
    calendars: [{ appId: "good", calendarId: "cal" }],
    ...shortRange,
    deadline: now + 10_000,
    ...overrides,
  });

test("one source can fail while another succeeds; returned busy fields are projected", async () => {
  const credentials = transport(["good", "bad"], ({ appId }) =>
    appId === "bad"
      ? json({ code: "FORBIDDEN", message: "No access" }, 403)
      : json({ data: { items: [{ ...busy, title: "private" }], next: null } }),
  );
  const result = await events(credentials, {
    calendars: [
      { appId: "bad", calendarId: "cal" },
      { appId: "good", calendarId: "cal" },
    ],
  });
  expect(result.sources).toEqual([
    { appId: "bad", state: "failed", error: { code: "FORBIDDEN", retryable: false } },
    { appId: "good", state: "ok", error: null },
  ]);
  expect(result.items).toEqual([{ ...busy, appId: "good" }]);
});

test("source discovery follows short and empty pages, projects fields, and uses localized catalog names", async () => {
  const credentials = transport(["good"], ({ input }) =>
    json({
      data: {
        items: input.cursor
          ? [{ id: "cal", name: "Team", suggested: true, visibility: "details", writable: false, secret: "private" }]
          : [],
        next: input.cursor ? null : "next",
      },
    }),
  );
  const result = await listCalendarSources(credentials, { deadline: now + 2500 });
  expect(result[0]).toEqual({
    appId: "good",
    name: "Calendar good",
    icon: "ti ti-calendar",
    state: "ok",
    error: null,
    calendars: [{ id: "cal", name: "Team", suggested: true, visibility: "details", writable: false }],
  });
});

test("42-day views split into elapsed 31-day windows across DST and dedupe overlapping events", async () => {
  const windows: Record<string, unknown>[] = [];
  const result = await events(
    transport(["good"], ({ input }) => {
      windows.push(input);
      return json({ data: { items: [busy], next: null } });
    }),
    range,
  );
  expect(windows).toHaveLength(2);
  expect(Date.parse(String(windows[1]!.to)) - Date.parse(String(windows[0]!.from))).toBe(42 * 86_400_000);
  expect(Date.parse(String(windows[0]!.to)) - Date.parse(String(windows[0]!.from))).toBe(31 * 86_400_000);
  expect(windows[1]!.from).toBe(windows[0]!.to);
  expect(windows[1]!.to).toBe(new Date(range.to).toISOString());
  expect(result.items).toHaveLength(1);
  expect(result.sources[0]!.state).toBe("ok");
});

test("cursor loops stop explicitly and empty continuable pages do not end iteration", async () => {
  let calls = 0;
  const result = await events(
    transport(["good"], () => {
      calls++;
      return json({ data: { items: [], next: "loop" } });
    }),
  );
  expect(calls).toBe(2);
  expect(result.sources[0]).toMatchObject({ state: "failed", error: { code: "CALENDAR_CURSOR_LOOP" } });
});

test("call budget counts empty pages and ends in truncated", async () => {
  let calls = 0;
  const result = await events(transport(["good"], () => json({ data: { items: [], next: `page-${++calls}` } })));
  expect(calls).toBe(59); // Catalog is one request too.
  expect(result.sources[0]).toMatchObject({ state: "truncated", error: { code: "CALENDAR_CALL_BUDGET" } });
});

test("byte budget counts page data even when no items arrive", async () => {
  let calls = 0;
  const result = await events(
    transport(["good"], () => json({ data: { items: [], next: `page-${++calls}`, padding: "x".repeat(230_000) } })),
  );
  expect(calls).toBeLessThan(60);
  expect(result.sources[0]).toMatchObject({ state: "truncated", error: { code: "CALENDAR_BYTE_BUDGET" } });
});

test("deadline aborts active sources, leaves queued sources pending and starts at most six", async () => {
  let started = 0;
  let aborted = 0;
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const credentials = transport(ids, ({ signal }) => {
    started++;
    signal.addEventListener("abort", () => aborted++);
    return new Promise(() => {});
  });
  const result = await events(credentials, { deadline: now + 40, calendars: ids.map((appId) => ({ appId, calendarId: "cal" })) });
  expect(started).toBe(6);
  expect(aborted).toBe(6);
  expect(result.sources.every((source) => source.state === "pending" && source.error?.code === "CALENDAR_DEADLINE")).toBe(true);
});

test("request abort prevents queued and further page calls", async () => {
  const abort = new AbortController();
  let calls = 0;
  const credentials = transport(["good"], () => {
    calls++;
    abort.abort();
    return json({ data: { items: [], next: "next" } });
  });
  const result = await events(credentials, { signal: abort.signal });
  expect(calls).toBe(1);
  expect(result.sources[0]).toMatchObject({ state: "pending", error: { code: "REQUEST_CANCELLED" } });
  await events(credentials, { signal: abort.signal });
  expect(calls).toBe(1);
});

test("zero calendars is empty without discovery; invalid ranges fail before calls", async () => {
  let calls = 0;
  const credentials: CapabilityCaller = {
    transport: async () => {
      calls++;
      throw new Error();
    },
  };
  expect(await events(credentials, { calendars: [] })).toEqual({ items: [], sources: [] });
  await expect(events(credentials, { to: "2027-01-01T00:00:00Z" })).rejects.toThrow();
  await expect(events(credentials, { ...range, to: new Date(Date.parse(range.to) + 1).toISOString() })).rejects.toThrow();
  expect(calls).toBe(0);
});

test("invalid capability envelopes remain explicit source failures", async () => {
  let calls = 0;
  const result = await events(
    transport(["good"], () => json({ data: { items: [], next: `page-${++calls}` }, ignored: "x".repeat(230_000) })),
  );
  expect(calls).toBe(1);
  expect(result.sources[0]).toMatchObject({ state: "failed", error: { code: "INVALID_APP_RESPONSE" } });
});

test("exactly 100 calendars can continue through a trailing empty page", async () => {
  let calls = 0;
  const result = await listCalendarSources(
    transport(["good"], ({ input }) => {
      calls++;
      return json({
        data: {
          items: input.cursor
            ? []
            : Array.from({ length: 100 }, (_, i) => ({
                id: `cal-${i}`,
                name: `Calendar ${i}`,
                suggested: false,
                visibility: "details",
                writable: false,
              })),
          next: input.cursor ? null : "empty-last",
        },
      });
    }),
    { deadline: now + 2500 },
  );
  expect(calls).toBe(2);
  expect(result[0]!.state).toBe("ok");
  expect(result[0]!.calendars).toHaveLength(100);
});
