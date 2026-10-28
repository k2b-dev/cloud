---
title: Offer calendars to Cloud
navTitle: Calendar sources
section: Platform services
order: 561
description: Offer authorized events, recurring occurrences, busy periods, and deadlines to a calendar view through ordinary Cloud capabilities.
tags: [capabilities, calendar, contracts, recurrence]
updated: 2026-10-26
---

# Offer calendars to Cloud

Declare a calendar source when people need to see your application's dates
alongside calendars from other applications. Your application owns its records,
recurrence expansion, permissions, and links. The platform supplies the shared
contract and a bounded server reader. Spaces owns the combined calendar view
and also offers its readable Space calendars as a source.

A source is an ordinary [capability declaration](/en/docs/platform/capabilities):

```ts
calendarSource: {
  calendars: "calendar.list",
  events: "calendar.events",
  // Optional Actions: update, move, delete.
}
```

Each value names a local Query or Action in the same application. Reuse the
schemas from `@k2b/cloud/contracts`. `calendarSource` bundles the five
operation contracts; `CALENDAR_SOURCE_FUNCTIONS` lists their names.
`calendarSourceIssues(manifest)` explains incompatibilities. Startup rejects an
incompatible declaration. The registry ignores an incompatible live source
and logs it once per manifest, while keeping its other capabilities.

## Declare the read operations

Both Queries declare `openWorld: false` and have no stream. Inputs are strict.
Results allow additional fields so older readers can continue to read the
known fields. Consumers must project those fields before returning them.

| Function | Input | Result |
| --- | --- | --- |
| `calendars` | `CalendarListInputSchema` | `CalendarListDataSchema` |
| `events` | `CalendarEventsInputSchema` | `CalendarEventsDataSchema` |

`CalendarListInputSchema` accepts `{ cursor?, limit? }`.
`CalendarEventsInputSchema` accepts
`{ calendarIds, from, to, cursor?, limit? }`:

- `calendarIds` contains 1–100 opaque source IDs, each 1–2,048 characters.
- `from` and `to` are timestamps with explicit offsets. `to > from`, and
  `to - from` is at most `CALENDAR_SOURCE_MAX_RANGE_MS`: 31 elapsed days.
- `limit`, when present, is an integer from 1 through
  `CALENDAR_SOURCE_PAGE_LIMIT` (100). A source chooses its default.
- `cursor` is an opaque string of 1–16,384 characters. Keep the selection,
  range, limit, and caller context unchanged when continuing.

Both result schemas return `{ items, next }`, with at most 100 items and a
cursor or `null`. A short or empty page with `next` means continue. Pages must
also fit the capability result budget of 256 KiB, including their envelope;
return fewer entries when needed. These limits match Spaces' agenda range and
page budget. Field bounds limit individual values and do not guarantee that
100 full entries fit in one response.

Omit unknown or no-longer-readable requested calendars silently. A fully
refused call returns an error. Do not turn a failed authorization check into a
successful empty page.

### Calendar descriptors

`CalendarDescriptorSchema` has these fields:

| Field | Meaning |
| --- | --- |
| `id` | Opaque source ID, 1–2,048 characters. |
| `name` | Display name, 1–200 characters. |
| `description?` | Optional display text, at most 500 characters. |
| `color?` | Optional six-digit hex color, `#rrggbb`. |
| `suggested` | Whether this caller should see the calendar selected initially. |
| `visibility` | `details` or `busy`: what this caller receives. |
| `writable` | Whether the source offers writes to this caller. This is a hint; each Action checks again. |
| `open?` | An `open` semantic link: `{ rel: "open", href, title? }`. |

All links use root-relative same-origin Cloud paths. Descriptors and items
use the existing capability semantic-link budgets. IDs and versions remain
opaque; consumers must not parse them or infer permissions from them.

## Return events, deadlines, and busy periods

`CalendarItemSchema` is a union on `type`. Every item has `id` and `calendarId`.
An ID is stable per occurrence: use the series and its original start, even
when an exception moves the occurrence. An exception row ID or its new start
must not replace the occurrence ID.

| Type | Additional fields |
| --- | --- |
| `event` | `time`, `title`, `location`, `status`, `transparency`, `occurrence`, `ref`, `open`, `version` |
| `deadline` | `due`, `title`, `done`, `occurrence`, `ref`, `open`, `version` |
| `busy` | `time`, `status`, `transparency` |

`title` is at most 500 characters. Event `location` is text of at most 500
characters or `null`. `status` is `confirmed` or `cancelled`;
`transparency` is `busy` or `free`. `ref` is a `CloudResourceRef` or `null`;
`open` is an `open` semantic link or `null`. `version` is an opaque string of
1–2,048 characters that changes whenever the item changes. Deadline `done`
is a boolean supplied by the source; a deadline has no duration.

A `busy` item contains no title, location, link, resource reference, recurrence
rule, or version. Never fill these fields with private data. Consumers use
`projectCalendarItem()` to remove every extra field, including nested fields;
busy projections retain only their documented fields.
`projectCalendarDescriptor()` does the same for descriptors.

### Times and range membership

`CalendarEventTimeSchema` / `CalendarEventTime` accepts:

```ts
type EventTime =
  | { kind: "date"; start: string; end: string }
  | { kind: "instant"; start: string; end: string; timeZone: string | null };
```

Date values are real `YYYY-MM-DD` dates, and their end is exclusive and after
the start. Instant values have explicit offsets, with `end >= start`.
`timeZone` is an IANA display zone or `null`. Floating times are invalid.

`CalendarDueTimeSchema` / `CalendarDueTime` accepts:

```ts
type DueTime =
  | { kind: "date"; date: string }
  | { kind: "instant"; at: string; timeZone: string | null };
```

The range is half-open, `[from, to)`. Events belong when they overlap it;
deadlines belong when their due point lies inside it. Interpret date-only
values using the source's configured date/time zone. Spaces uses its
application date configuration. Its legacy inclusive all-day ends become
exclusive date ends; existing exclusive midnight ends remain exclusive.

### Recurrence

The source expands recurrences within the requested range. Return each
occurrence separately with `CalendarOccurrenceSchema`:

```ts
{ seriesId: string; originalStart: string; rule: string | null }
```

`seriesId` is an opaque ID. `originalStart` is a timestamp with an offset or a
real date. `rule` is an RRULE of at most 1,000 characters, for display only.
Consumers never re-expand it. Use `occurrence: null` for ordinary items.
Spaces uses `rule: null` for a valid legacy rule longer than the display limit;
its occurrences remain available.

Spaces returns only open calendar items: scheduled tasks and appointments as
events, and tasks with only a due value as deadlines. Recurring overrides keep
the series' original occurrence identity and link to its existing detail view.
Its pages are chronological and use a cursor scoped to caller, selection,
range, and limit. It uses the existing calendar complete-read guard; an
expansion it cannot complete answers `CALENDAR_READ_LIMIT` instead of a
successful partial source page.

## Reserve versioned writes

A source may declare any of the three Actions independently. Spaces declares
none in this version and returns `writable: false`.

| Action | Input schema | Result schema |
| --- | --- | --- |
| `update` | `CalendarUpdateInputSchema` | `CalendarUpdateDataSchema`: `{ item }` |
| `move` | `CalendarMoveInputSchema` | `CalendarMoveDataSchema`: `{ item }` |
| `delete` | `CalendarDeleteInputSchema` | `CalendarDeleteDataSchema`: `{}` |

All inputs contain `{ calendarId, id, version, scope? }`. `scope` is
`occurrence` or `series`; a source requires an explicit scope when writing a
recurring occurrence. The source checks the current caller's rights and may
reject with a stable error code and a clear reason.

`update` also contains `changes: { title?, location?, done? }`. `location: null`
clears the location. `move` contains exactly one of `time` or `due`, using the
time schemas above. Nested write objects are strict too. Sources reject fields
that do not apply to the item type.

Require `idempotency: "required"` for every write. Declare `openWorld: false`
and no stream. `delete` is destructive and follows the normal destructive
Action review rules. At the transaction that writes, compare `version` with
the current version. A mismatch returns HTTP 409 with
`CALENDAR_VERSION_CONFLICT`; never overwrite the newer item. Refetch and let
the person decide again. An idempotent retry returns its earlier result.

## Authorize each call

Discovery uses the per-caller capability catalog. A listed application or
calendar, `suggested`, and `writable` grant nothing. Authorize every Query and
Action with the normal `actor` and `accessSubject` path, including credential
scope and resource bindings. Do not derive access from `accessSubject` alone.

A resource-bound Spaces account remains restricted to its bound Space even
when it has another Space grant. An unbound account uses its own grants and
credential scopes. Never keep catalogs or source results across people.
A caller-dependent error stays an error; its translated explanation belongs
to the application, while consumer state carries stable codes.

## Read several sources on the server

Import `listCalendarSources()` and `readCalendarEvents()` from
`@k2b/cloud/capabilities/server`, beside `invokeCapabilityWithDataSchema()`.
Pass the current request's cookie or authorization header, request ID, locale,
trace headers, and signal as `CapabilityCaller`. The catalog and invocations
use those credentials through the normal Core capability endpoints.
`listCapabilityCatalog({ caller, cursor?, limit? })` also supports this
credential-forwarding catalog path; the limit is 1–25.

```ts
const sources = await listCalendarSources(credentials, {
  deadline: Date.now() + 2500,
  signal,
});
const result = await readCalendarEvents({
  credentials,
  calendars: [{ appId: "absence", calendarId: "mine" }],
  from: "2026-11-01T00:00:00Z",
  to: "2026-12-01T00:00:00Z",
  signal,
  deadline: Date.now() + 2500,
  onSource: (source) => reportProgress(source),
});
```

`deadline` is an absolute epoch time in milliseconds. Source discovery returns
per application `{ appId, name, icon, state, error, calendars }`. `name` is the
localized catalog title; `icon` and `error` may be `null`. `state` is `ok` or
`failed`. It follows continuations up to 100 calendars per application; an
incomplete list has a failure code. A catalog failure rejects discovery so the
view can show a retry state.

Event reads return `{ items, sources }`. Each item carries `appId` alongside
its projected source fields. Each source carries `{ appId, state, error }`,
where `error` is `{ code, retryable }` or `null`. `onSource`, when supplied,
receives a source's final progress state. An empty calendar selection returns
empty items and source states without discovery.

The interactive request budget is:

- at most 42 elapsed days, split into windows of at most 31 elapsed days;
- at most 100 selected calendars, grouped by application;
- at most 60 total calls, counting catalog pages and empty source pages;
- at most six calls in flight and 4 MiB of summed page bytes, including catalog pages;
- the caller's overall deadline: Spaces uses 2.5 seconds for SSR and
  10 seconds for browser reloads.

Window boundaries use elapsed milliseconds, including across DST changes.
Duplicate items from overlapping windows are removed by
`(appId, calendarId, id)`. One source failure leaves the others available.
Successful sources end in `ok`. At the deadline, active calls are aborted,
queued calls do not start, and unfinished sources become `pending`. A request
abort also stops work. Call or byte exhaustion makes unfinished sources
`truncated`. Already returned items remain available.

| Code | Meaning and recovery |
| --- | --- |
| `CALENDAR_VERSION_CONFLICT` | A stale write; refetch before deciding again. HTTP 409. |
| `CALENDAR_DEADLINE` | The view deadline passed; retry unfinished sources. |
| `REQUEST_CANCELLED` | The originating request was aborted. |
| `CALENDAR_CALL_BUDGET` / `CALENDAR_BYTE_BUDGET` | Partial read; narrow the selection or range. |
| `CALENDAR_CALENDAR_BUDGET` | Source discovery reached 100 calendars while more remain. |
| `CALENDAR_CURSOR_LOOP` | A source or catalog repeated a cursor; restart or repair its pagination. |
| `CALENDAR_INVALID_CURSOR` | Spaces cursor inputs changed; restart without the cursor. |
| `CALENDAR_AMBIGUOUS_TIME` / `CALENDAR_AMBIGUOUS_RECURRENCE` | Spaces cannot represent legacy data unambiguously; correct it in Spaces. |
| `CALENDAR_READ_LIMIT` | Spaces could not complete bounded recurrence expansion; narrow the range or selection. |
| `CALENDAR_ITEM_TOO_LARGE` | One source item cannot fit the capability response. |
| Other capability codes | Keep their code and source state; authorization and availability failures retain their meaning. |

The server helper schemas and types are also exported from
`@k2b/cloud/contracts`: `CalendarViewRangeSchema`, `CalendarSourceErrorSchema`,
`CalendarSourceStateSchema`, `CalendarSourceSummarySchema`,
`CalendarSourceListEntrySchema`, and `CalendarReadResultSchema`.

## Example: offer personal absences

This complete declaration uses a small fixture as the absence store. Replace
the store with your application's permission-aware database service. Its dates
use UTC, it rejects actors without user-backed credentials, and every read
filters by that person's ID. Unknown calendar IDs produce no entries. Cursors
are bound to the person, selection, range, and page size.

The following checked example includes the declaration and a server consumer:

```ts
import { createHash } from "node:crypto";
import { defineCapabilities } from "@k2b/cloud";
import { type CapabilityCaller, listCalendarSources, readCalendarEvents } from "@k2b/cloud/capabilities/server";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import {
  CalendarEventsDataSchema,
  CalendarEventsInputSchema,
  type CalendarItem,
  CalendarListDataSchema,
  CalendarListInputSchema,
  type CapabilityExecutionContext,
  calendarSourceIssues,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { z } from "zod";

// Example data only. A deployed app reads its own authorized absence records from its database.
const absences = [{ id: "leave-1", ownerId: "user-42", title: "Annual leave", start: "2026-11-02", end: "2026-11-07", revision: "1" }];
const callerId = (context: CapabilityExecutionContext) => {
  const userBacked = context.actor.kind === "user" || context.actor.serviceAccount.kind === "user_delegated";
  return userBacked && context.user && context.accessSubject.type === "user" && context.user.id === context.accessSubject.userId
    ? context.user.id
    : null;
};
const cursorSchema = z.object({ scope: z.string(), offset: z.number().int().nonnegative() }).strict();
export const absenceCapabilities = defineCapabilities({
  protocolVersion: 2,
  calendarSource: { calendars: "calendar.list", events: "calendar.events" },
  queries: {
    "calendar.list": {
      title: "List absence calendars",
      description: "Offer the current person's own absence calendar.",
      input: CalendarListInputSchema,
      data: CalendarListDataSchema,
      openWorld: false,
      run: async (input, context) => {
        if (!callerId(context)) return fail(err.forbidden("A user-backed actor is required"));
        if (input.cursor) return fail(err.badInput("This calendar list has no continuation"));
        return ok({
          data: {
            items: [
              {
                id: "mine",
                name: "My absences",
                color: "#0f766e",
                suggested: true,
                visibility: "details" as const,
                writable: false,
                open: { rel: "open" as const, href: "/app/absence?view=calendar" },
              },
            ],
            next: null,
          },
        });
      },
    },
    "calendar.events": {
      title: "Read absences",
      description: "Read the current person's absence dates in a half-open UTC range.",
      input: CalendarEventsInputSchema,
      data: CalendarEventsDataSchema,
      openWorld: false,
      run: async (input, context) => {
        const userId = callerId(context);
        if (!userId) return fail(err.forbidden("A user-backed actor is required"));
        const limit = input.limit ?? 100;
        const scope = createHash("sha256")
          .update(JSON.stringify([userId, input.calendarIds, input.from, input.to, limit]))
          .digest("hex");
        let offset = 0;
        if (input.cursor) {
          try {
            const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
            if (cursor.scope !== scope) throw new Error();
            offset = cursor.offset;
          } catch {
            return fail(err.badInput("Invalid calendar cursor"));
          }
        }
        const matches = absences
          .filter(
            (row) =>
              row.ownerId === userId &&
              input.calendarIds.includes("mine") &&
              Date.parse(`${row.start}T00:00:00Z`) < Date.parse(input.to) &&
              Date.parse(`${row.end}T00:00:00Z`) > Date.parse(input.from),
          )
          .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
        const items: CalendarItem[] = matches.slice(offset, offset + limit).map((row) => ({
          type: "event",
          id: row.id,
          calendarId: "mine",
          title: row.title,
          time: { kind: "date", start: row.start, end: row.end },
          location: null,
          status: "confirmed",
          transparency: "busy",
          occurrence: null,
          ref: null,
          open: { rel: "open", href: `/app/absence?item=${encodeURIComponent(row.id)}` },
          version: row.revision,
        }));
        const nextOffset = offset + items.length;
        return ok({
          data: {
            items,
            next: nextOffset < matches.length ? Buffer.from(JSON.stringify({ scope, offset: nextOffset })).toString("base64url") : null,
          },
        });
      },
    },
  },
});
export const absenceManifest = compileCapabilityManifest("absence", absenceCapabilities);
if (calendarSourceIssues(absenceManifest).length) throw new Error("Invalid calendar source");

export const readPersonalCalendar = async (credentials: CapabilityCaller, signal: AbortSignal) => {
  const sources = await listCalendarSources(credentials, { deadline: Date.now() + 2500, signal });
  const calendars = sources
    .flatMap((source) =>
      source.calendars.filter((calendar) => calendar.suggested).map((calendar) => ({ appId: source.appId, calendarId: calendar.id })),
    )
    .slice(0, 100);
  return readCalendarEvents({
    credentials,
    calendars,
    from: "2026-11-01T00:00:00Z",
    to: "2026-12-01T00:00:00Z",
    signal,
    deadline: Date.now() + 2500,
  });
};
```

Pass `absenceCapabilities` as the `capabilities` option of `app.start()`
after creating the absence application with `defineApp()`. Mount the `open`
destinations as authorized application pages.

The capability schemas export matching TypeScript types for the list, events,
event time, due time, occurrence, item, update, move, and delete inputs and
results. Check your manifest with `calendarSourceIssues()` in a focused test
before offering it to consumers.
