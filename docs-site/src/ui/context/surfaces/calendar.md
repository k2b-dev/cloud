# Calendar

`Calendar` renders portable day, week, month, year, and compact mobile-month
views. The application owns the selected date and view, canonical URLs, event
data, permissions, and editor flows.

## Use Calendar

Use it for schedules that need timezone-aware placement, all-day and timed
events, or direct manipulation. Keep date and view state in the URL when the
calendar is a primary application surface.

## Import

```tsx
import {
  Calendar,
  type CalendarAttendee,
  type CalendarDayBadge,
  type CalendarEvent,
  type CalendarEventColor,
  type CalendarEventRenderContext,
  type CalendarEventTimeChange,
  type CalendarLabels,
  type CalendarProps,
  type CalendarRecurrence,
  type CalendarResource,
  type CalendarView,
} from "@k2b/ui";
```

## Events

Every `CalendarEvent` has an `id`, `title`, and `start`. `end` and `allDay`
control placement. `color` accepts the shared semantic palette; `colorHex`
supports an application-defined calendar color.

Optional event detail includes `meta`, `description`, `location`,
`calendarName`, attendees, resources, and recurrence metadata. `display:
"background"` renders a non-interactive time range. `href` or
`getEventHref` makes an event a canonical link.

`description` is optional plain text. The default timed-event card shows up to
two lines when its duration is at least 90 minutes; compact, all-day, and
smaller cards omit it. Applications that store Markdown or other rich text
should pass a short plain-text preview instead of the source markup.

`renderEvent(event, context)` receives the event and normalized `CalendarEventRenderContext`, including
the effective start, end, duration, time label, and compact or fill state.
Custom output must retain useful visible event text.

## Views and navigation

`view` accepts:

- `day` for one timed column;
- `week` for seven timed columns;
- `month` for the standard month grid;
- `year` for a compact twelve-month overview;
- `mobile-month` for a bounded month picker with the selected day's agenda.

Limit the switcher with `views`. `getDateHref`, `getViewHref`, and
`getEventHref` keep navigation functional in the server response.
`onNavigate` progressively enhances those links after hydration.

In the month view, the empty day surface follows `getDateHref` to the day view
when `onSlotActivate` is absent. Passing `onSlotActivate` deliberately turns
that surface into an empty-slot action instead; the day number remains a
separate navigation link when both contracts are available.

Use `onDateChange`, `onViewChange`, and `onEventActivate` only when client state
is appropriate. `navigationPending` exposes loading state without replacing
the canonical links.

## Date and layout policy

`dateConfig` passes the `@k2b/stdlib` date context. `timeZone` and
`firstDayOfWeek` are convenience overrides. `withWeekNumbers` adds week
labels. An explicit `dateConfig.locale` wins; without one the calendar
inherits the render locale from `LocaleProvider` or the browser's
`<html lang>` (see the Locale and formatting page). The timezone never comes
from the locale context.

Day and week views accept `startHour`, `endHour`, `visibleStartHour`, and
`visibleEndHour`. `hideAllDay` and `allDayMaxHeightRem` control the all-day
lane. `selectedDate`, `selectedEventId`, and `dayBadges` add host-owned
selection and compact status context.

## Interaction

The following callbacks enable matching hydrated interactions:

- `onEventDrop` moves an event;
- `onEventResize` changes a timed event duration;
- `onEventActivate` activates an event;
- `onSlotActivate` activates an empty time range.

Set `eventActivation` or `slotActivation` to `"double"` only for dense editing
surfaces that deliberately reserve single click for selection. Both default to
`"single"`. The component does not delay single-click callbacks to guess
whether a second click will follow.

`onEventActivate(event: CalendarEvent)` receives the selected event.
`onEventDrop(event, next)` and `onEventResize(event, next)` receive the original
event and `{ start: Date; end: Date; allDay?: boolean }`.
`onSlotActivate(slot)` receives that time-range shape alone. All return `void`.
The host validates permissions and persists changes.

`toolbarActions` and `toolbarContent` add bounded application controls without
replacing the calendar navigation.

## API reference

```ts
type CalendarView = "day" | "week" | "month" | "year" | "mobile-month";

type CalendarEventColor = "blue" | "emerald" | "amber" | "red" | "violet" | "cyan" | "zinc";

type CalendarAttendee = {
  name: string; status?: "accepted" | "declined" | "tentative" | "needs-action";
};

type CalendarResource = {
  name: string; kind?: "room" | "equipment" | "link" | "other";
};

type CalendarRecurrence = {
  rrule: string; exdate?: Array<Date | string>; recurrenceId?: Date | string;
};

type CalendarEvent = {
  id: string; title: string; start: Date | string; end?: Date | string; allDay?: boolean;
  color?: CalendarEventColor; colorHex?: string; href?: string; dataSpaceItemId?: string; meta?: string;
  description?: string; display?: "event" | "background"; location?: string; calendarName?: string;
  attendees?: CalendarAttendee[]; resources?: CalendarResource[]; recurrence?: CalendarRecurrence;
};

type CalendarLabels = Partial<{
  today: string; day: string; week: string; month: string; year: string; allDay: string; noEvents: string;
  previous: string; next: string;
}>;

type CalendarDayBadge = {
  icon?: string; label: string;
};

```

### Callback data

```ts
type CalendarEventRenderContext = {
  compact: boolean; fill: boolean; start: Date; end: Date; allDay: boolean; durationHours: number;
  timeLabel: string;
};

type CalendarEventTimeChange = {
  start: Date; end: Date; allDay?: boolean;
};

```

### Calendar props

```ts
type CalendarProps = {
  date: Date | string; events: CalendarEvent[]; view?: CalendarView; views?: CalendarView[];
  labels?: CalendarLabels; dateConfig?: DateContext; timeZone?: string; firstDayOfWeek?: 0 | 1;
  withWeekNumbers?: boolean; startHour?: number; endHour?: number; visibleStartHour?: number;
  visibleEndHour?: number; allDayMaxHeightRem?: number; hideAllDay?: boolean; selectedDate?: Date | string;
  selectedEventId?: string; dayBadges?: Record<string, CalendarDayBadge>;
  getViewHref?: (view: CalendarView) => string; getDateHref?: (date: Date, view: CalendarView) => string;
  getEventHref?: (event: CalendarEvent) => string | undefined;
  renderEvent?: (event: CalendarEvent, context: CalendarEventRenderContext) => JSX.Element;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>; onNavigateHref?: (href: string) => void;
  onPrefetch?: (href: string) => void; navigationPending?: boolean;
  onViewChange?: (view: CalendarView) => void; onDateChange?: (date: Date, view: CalendarView) => void;
  onEventActivate?: (event: CalendarEvent) => void; eventActivation?: "single" | "double";
  onEventDrop?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onEventResize?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onSlotActivate?: (slot: CalendarEventTimeChange) => void; slotActivation?: "single" | "double";
  toolbarActions?: JSX.Element; toolbarContent?: JSX.Element; class?: string;
};
```

Dates accept `Date` or parseable strings. Prefer date-only strings for calendar days and offset-bearing ISO instants for timed events. Recurrence is metadata; the host supplies the occurrences to display. `dayBadges` is keyed by `YYYY-MM-DD`. `dateConfig` uses [DateContext](/en/ui/content/intl#date-and-locale-options).

Defaults: `view="month"`, week starts Monday unless overridden, `visibleStartHour=0`, `visibleEndHour=24`, `startHour=8`, `endHour=18`, and `allDayMaxHeightRem=7`. Visible hours bound the grid; start/endHour mark business hours. Boolean features are opt-in except the single-click activation defaults described above. `onNavigate` uses [LinkNavigateEvent](/en/ui/getting-started#icons-tones-and-navigation); `onNavigateHref` is the separate string callback without a document view transition. `onPrefetch` receives the canonical URL to preload. Callbacks do not persist edits.

## Accessibility

Canonical links remain available before hydration. Date cells, navigation,
events, and interaction handles have text or accessible labels. Color is
supplementary to event title, time, and metadata.

## Runtime

All views, labels, dates, and links render on the server. Drag, resize,
pointer-slot selection, prefetch, and callback navigation require hydration.

## Example

```tsx
const events: CalendarEvent[] = [
  {
    id: "review",
    title: "Design review",
    start: "2026-07-15T09:00:00Z",
    end: "2026-07-15T10:00:00Z",
    color: "emerald",
    location: "Studio",
  },
  {
    id: "release",
    title: "Release",
    start: "2026-07-18T00:00:00Z",
    allDay: true,
    color: "blue",
  },
];

<Calendar
  date="2026-07-15T12:00:00Z"
  events={events}
  view="month"
  views={["day", "week", "month", "year"]}
  timeZone="UTC"
  withWeekNumbers
  getDateHref={(date, view) =>
    `?view=${view}&date=${date.toISOString()}`
  }
  getViewHref={(view) => `?view=${view}`}
  onEventActivate={(event) => openEvent(event.id)}
  onSlotActivate={(slot) => createEvent(slot)}
/>;
```
