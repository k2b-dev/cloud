# Calendar

`Calendar` renders portable day, week, month, year, and compact mobile-month
views, and hosts views an application adds, such as a
[Timeline](/en/ui/content/timeline). The application owns the selected date
and view, canonical URLs, event data, permissions, and editor flows.

## Use Calendar

Use it for schedules that need timezone-aware placement, all-day and timed
events, or direct manipulation. Keep date and view state in the URL when the
calendar is a primary application surface.

## Import

```tsx
import {
  Calendar,
  type CalendarAttendee,
  type CalendarCustomView,
  type CalendarDayBadge,
  type CalendarEvent,
  type CalendarEventColor,
  type CalendarEventRenderContext,
  type CalendarEventTimeChange,
  type CalendarLabels,
  type CalendarProps,
  type CalendarQuickCreateControls,
  type CalendarRecurrence,
  type CalendarResource,
  type CalendarSelectionControls,
  type CalendarView,
} from "@k2b/ui";
```

## Events

Every `CalendarEvent` has an `id`, `title`, and `start`. `end` and `allDay`
control placement. `color` accepts the shared semantic palette; `colorHex`
supports an application-defined calendar color.

Optional event detail includes `meta`, `description`, `location`,
`calendarName`, attendees, resources, and recurrence metadata. `display:
"background"` renders a non-interactive time range. `display: "marker"` draws
a point in time, such as a deadline, as a small colored marker beside its title
on the plain surface instead of a filled band; hover and selection tint it like
an event, and a custom `renderEvent` output replaces the default marker.
`href` or `getEventHref` makes an event a canonical link.
`accessibleDetail` adds short text to the event's accessible name for state
that its content shows only visually, such as a priority flag in a custom
`renderEvent` output.

`description` is optional plain text. The default timed-event card shows up to
two lines when its duration is at least 90 minutes; compact, all-day, and
smaller cards omit it. Applications that store Markdown or other rich text
should pass a short plain-text preview instead of the source markup.

`renderEvent(event, context)` receives the event and normalized `CalendarEventRenderContext`, including
the effective start, end, duration, time label, compact or fill state, and in
the month view the `leadingTime` to show before a one-day entry's title.
Custom output must retain useful visible event text. Entries of the month
view and its day list are always `compact` and one line high, the height of
a lane: render a single line there, title first, or the lane cuts the rest
off. Put state that the line shows only as an icon into `accessibleDetail`.

## Views and navigation

`view` accepts:

- `day` for one timed column;
- `week` for seven timed columns;
- `month` for the standard month grid;
- `year` for a compact twelve-month overview;
- `mobile-month` for a bounded month picker with the selected day's agenda.
  Its weeks are compact rows at least 44 px (2.75rem) tall instead of the
  month view's full height, so the agenda follows close below the grid.

Limit the switcher with `views`. `getDateHref`, `getViewHref`, and
`getEventHref` keep navigation functional in the server response.
`onNavigate` progressively enhances those links after hydration.

### Add a view

`customViews` adds views after the built-in ones, each with a `value` and a
`label`. While `view` is one of them, the calendar keeps its header and
`toolbarContent` and shows `children` as the body; `events` are not drawn.
The header names the day of `date` and pages by one day, as in the day view.
The view's value reaches `getViewHref`, `getDateHref`, `onViewChange`, and
`onDateChange` like a built-in one, and JSX infers its type from
`customViews`. The application renders the body from its own data, for
example a `Timeline` of the loaded days.

```tsx
<Calendar
  view={view()}
  customViews={[{ value: "timeline", label: "Timeline" }]}
  date={date()}
  events={events()}
  getViewHref={(next) => `?view=${next}`}
  getDateHref={(next, current) => `?view=${current}&date=${dateKey(next)}`}
>
  <Show when={view() === "timeline"}>
    <Timeline items={items()} from={range().from} to={range().to} />
  </Show>
</Calendar>;
```

### Month view

The month view is a grid of selectable days (`role="grid"`, each day a
`gridcell` with `aria-selected`). A click or tap on a day selects it and never
navigates. A drag across days, or Shift with a click or an arrow key, selects
a range; the selection shows as one tinted band with stronger ends and an
inner line. The arrow keys move the selection and page to the next or
previous month at the edge of the grid; Home and End go to the start and end
of the week, Page Up and Page Down to the same day of the previous and next
month, or to that month's last day when it is shorter; the previous and next
buttons step the same way. Escape closes an open popover first and then
clears the selection. A new month starts without a selection. A range takes a
mouse or the keyboard; on a touch screen a tap selects one day.

The day view is a deliberate step, never a side effect of a click:

- the view switcher opens the day, week, and year views at the first
  selected day;
- the menu of a day ends with “Open day” and “Open week”;
- the day list behind “+N” or Space has an “Open day” button;
- with `withWeekNumbers`, each week number opens its week.

They use `getDateHref`, or `onViewChange` and then `onDateChange` with the
day and the view when the host has no links, and appear only for views in
`views`.

Creating works on the selection:

- `renderQuickCreate(range, { create, close })` renders the content of the
  quick create, a popover at the selection. After a mouse click on a day it
  opens quietly: the grid keeps the focus, the arrow keys move the selection
  and the popover with it, and Space still opens the day list. Tab moves
  into it, and so does any other character, N included, as the first letter
  of its first field. After a drag across days, a double-click, Enter, or N
  it opens with the focus in its first field. On a touch screen a tap only
  selects; a second tap on the selected day opens it. Escape or a click
  elsewhere closes it and keeps the selection. The application owns the
  form, calls `close` after saving, and receives in `create` what a menu
  entry asked for; a `close` that comes after another quick create took its
  place, such as at the end of a slow save, does nothing. It never shifts
  the layout of the grid.
- `selectionMenu(range, { quickCreate })` returns the application's entries
  of the menu that a right-click, a long press, the Context Menu key, or
  Shift+F10 opens on a day. The calendar heads them with the day, or the
  range and its number of days, and adds “Open day”, “Open week”, and, for a
  range, “Clear selection”. `quickCreate(create)` opens the quick create at
  the menu's days with the focus in it. A press inside the selection acts on
  all of it; elsewhere it selects the day under the pointer first, also on a
  bar that spans several days. Escape closes the menu and returns the focus
  to the pressed day. Without the prop the menu holds the calendar's own
  entries; only a host that can open no other view leaves the browser its own
  menu. Entries that are links or buttons always keep the browser's menu.
- `onSelectionChange(range)` reports every change of the selected days, and
  `null` when nothing is selected, also when another view replaces the month
  view, for actions outside the grid such as a toolbar button that creates
  on the selected days.
- Without `renderQuickCreate`, Enter and a double-click call
  `onSlotActivate` with the selection.

Every range these props receive is all-day: `start` is the first day's
midnight and `end` the midnight after the last day.

All-day and multi-day events are bars: one bar per week row, in a lane it
keeps on all of its days, with its title in each row it reaches. Where the
row cuts the event off, the bar ends in a torn, zigzag edge. When the bar has
room for its title and a date, the torn end names where the event continues,
for example “until 13” and “from 7” (“bis 13.” and “seit 7.” in German), with
the month when that day lies outside the shown month (“until Nov 3”); a
narrow bar leaves the date out. A bar's accessible name names the whole
range, for example “Fair setup, October 7 to October 13”. Pointing at one bar
of an event highlights its bars in the other rows. One-day events stack below
the bars of their day in start-time order and show the start time before the
title, which `renderEvent` receives as `context.leadingTime`.

Each cell draws as many rows as fit its measured height. A day with more
entries gives its last row to “+N more”, which counts every entry of the day
that is not drawn, hidden bars included; days that fit keep all their rows.
A bar is drawn only when it fits on every day it covers, so a count never
cuts it. “+N more” and Space open the day list: every entry of the day, “Open
day”, and, with `renderQuickCreate`, “New event”. The cells' size depends
only on the grid, never on their content, so resizing changes the counts and
moves nothing. The server renders three rows until the browser has measured.
On a narrow screen the entries keep their titles at a tighter padding, and
the count shows only “+N”. Dragging a bar with `onEventDrop` moves the event
by as many days as the pointer moved and highlights the days it would cover.

`mobile-month` keeps its compact picker: its days link to their agenda
through `getDateHref`, and colored dots stand for the day's events.

On a device with a coarse pointer, the previous and next buttons accept taps
in the same invisible 44 px area as other buttons, following the
[touch target contract](/en/ui/actions/buttons#touch-targets); their visible
size stays the same.

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
- `onSlotActivate` activates an empty time range, or the selected days of
  the month view when it has no `renderQuickCreate`.

Set `eventActivation` or `slotActivation` to `"double"` only for dense editing
surfaces that deliberately reserve single click for selection. The month view
always reserves a single click for selecting days, whatever
`slotActivation` says. Both default to
`"single"`. The component does not delay single-click callbacks to guess
whether a second click will follow.

`onEventActivate(event: CalendarEvent)` receives the selected event.
`onEventDrop(event, next)` and `onEventResize(event, next)` receive the original
event and `{ start: Date; end: Date; allDay?: boolean }`.
`onSlotActivate(slot)` receives that time-range shape alone. All return `void`.
The host validates permissions and persists changes.

The toolbar is one row: previous and next, the period title,
`toolbarContent`, and then Today, the view switcher, and `toolbarActions` at
the end. Put application controls such as filters in `toolbarContent`; there
is no separate row below the toolbar, and the content fills the space up to
Today, so a status such as a count can sit at its end. The title reserves the
width of the widest title of its view (all months of the year, the weeks of
the month, or the longest day names), so paging never moves what follows it.
The toolbar draws no line toward the body. It adapts to its own width, not
the window's:

- up to 84rem, filter chips in `toolbarContent` show only their icon, with
  their name kept as accessible name;
- up to 64rem, `toolbarContent` takes a row of its own below the title, with
  the chips' names;
- up to 40rem, the first row holds the navigation, the title, Today, and
  `toolbarActions`, and the second the view switcher and `toolbarContent`,
  with icon-only chips. Keep `toolbarActions` compact there, for example an
  icon with a visually hidden label.

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
  description?: string; display?: "event" | "background" | "marker"; accessibleDetail?: string;
  location?: string; calendarName?: string;
  attendees?: CalendarAttendee[]; resources?: CalendarResource[]; recurrence?: CalendarRecurrence;
};

type CalendarLabels = Partial<{
  today: string; day: string; week: string; month: string; year: string; allDay: string; noEvents: string;
  previous: string; next: string;
}>;

type CalendarDayBadge = {
  icon?: string; label: string;
};

type CalendarCustomView<V extends string = string> = {
  value: V; label: string;
};

```

### Callback data

```ts
type CalendarEventRenderContext = {
  compact: boolean; fill: boolean; start: Date; end: Date; allDay: boolean; durationHours: number;
  timeLabel: string; leadingTime?: string;
};

type CalendarSelectionControls = {
  quickCreate: (create?: string) => void;
};

type CalendarQuickCreateControls = {
  create?: string; close: () => void;
};

type CalendarEventTimeChange = {
  start: Date; end: Date; allDay?: boolean;
};

```

### Calendar props

```ts
type CalendarProps<V extends string = never> = {
  date: Date | string; events: CalendarEvent[]; view?: CalendarView | V; views?: CalendarView[];
  customViews?: CalendarCustomView<V>[]; children?: JSX.Element; labels?: CalendarLabels; dateConfig?: DateContext; timeZone?: string; firstDayOfWeek?: 0 | 1;
  withWeekNumbers?: boolean; startHour?: number; endHour?: number; visibleStartHour?: number;
  visibleEndHour?: number; allDayMaxHeightRem?: number; hideAllDay?: boolean; selectedDate?: Date | string;
  selectedEventId?: string; dayBadges?: Record<string, CalendarDayBadge>;
  getViewHref?(view: CalendarView | V): string; getDateHref?(date: Date, view: CalendarView | V): string;
  getEventHref?: (event: CalendarEvent) => string | undefined;
  renderEvent?: (event: CalendarEvent, context: CalendarEventRenderContext) => JSX.Element;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>; onNavigateHref?: (href: string) => void;
  onPrefetch?: (href: string) => void; navigationPending?: boolean;
  onViewChange?(view: CalendarView | V): void; onDateChange?(date: Date, view: CalendarView | V): void;
  onEventActivate?: (event: CalendarEvent) => void; eventActivation?: "single" | "double";
  onEventDrop?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onEventResize?: (event: CalendarEvent, next: CalendarEventTimeChange) => void;
  onSlotActivate?: (slot: CalendarEventTimeChange) => void; slotActivation?: "single" | "double";
  onSelectionChange?: (range: CalendarEventTimeChange | null) => void;
  selectionMenu?: (range: CalendarEventTimeChange, controls: CalendarSelectionControls) => readonly DropdownItem[];
  renderQuickCreate?: (range: CalendarEventTimeChange, controls: CalendarQuickCreateControls) => JSX.Element;
  toolbarActions?: JSX.Element; toolbarContent?: JSX.Element; class?: string;
};
```

Dates accept `Date` or parseable strings. Prefer date-only strings for calendar days and offset-bearing ISO instants for timed events. Recurrence is metadata; the host supplies the occurrences to display. `dayBadges` is keyed by `YYYY-MM-DD`. `dateConfig` uses [DateContext](/en/ui/content/intl#date-and-locale-options).

Defaults: `view="month"`, week starts Monday unless overridden, `visibleStartHour=0`, `visibleEndHour=24`, `startHour=8`, `endHour=18`, and `allDayMaxHeightRem=7`. Visible hours bound the grid; start/endHour mark business hours. Boolean features are opt-in except the single-click activation defaults described above. `onNavigate` uses [LinkNavigateEvent](/en/ui/getting-started#icons-tones-and-navigation); `onNavigateHref` is the separate string callback without a document view transition. `onPrefetch` receives the canonical URL to preload. Callbacks do not persist edits.

## Accessibility

Canonical links remain available before hydration. Date cells, navigation,
events, and interaction handles have text or accessible labels. Color is
supplementary to event title, time, and metadata.
A timed event's accessible name combines its title and time range in the
render locale, for example “Review, 09:00 to 10:00” or “Review, 09:00 bis
10:00”; an all-day event uses its title alone. `accessibleDetail` follows
after a comma, for example “Review, 09:00 to 10:00, Priority: High”. The name
replaces the event's visible content for screen readers, so custom
`renderEvent` output that shows state only as an icon or color passes that
state here.

The day and week views scroll to `startHour` once they mount: smoothly by
default, and at once when the person prefers reduced motion.

## Runtime

All views, labels, dates, and links render on the server. Drag, resize,
pointer-slot selection, day selection, the month menu and popovers, measured
month lanes, prefetch, and callback navigation require hydration.

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
