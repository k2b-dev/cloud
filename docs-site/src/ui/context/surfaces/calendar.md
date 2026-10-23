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
  type CalendarCommand,
  type CalendarController,
  type CalendarCustomView,
  type CalendarDayBadge,
  type CalendarEvent,
  type CalendarEventColor,
  type CalendarEventRenderContext,
  type CalendarEventTimeChange,
  type CalendarExternalDrag,
  type CalendarLabels,
  type CalendarProps,
  type CalendarQuickCreateControls,
  type CalendarRange,
  type CalendarRecurrence,
  type CalendarResource,
  type CalendarSelectionControls,
  type CalendarView,
} from "@k2b/ui";
```

## Events

Every `CalendarEvent` has an `id`, `title`, and `start`. `end` and `allDay`
control placement. Set `editable: false` on an event to disable moving and resizing it,
even when the calendar has drop and resize callbacks. The event can still be opened;
the application must also enforce its write permissions on the server.

`color` accepts the shared semantic palette; `colorHex`
supports an application-defined calendar color.

Optional event detail includes `meta`, `description`, `location`,
`calendarName`, attendees, resources, and recurrence metadata. `display:
"background"` renders a non-interactive time range. `display: "marker"` draws
a point in time, such as a deadline, as a small colored marker beside its title
on the plain surface instead of a filled band; hover and selection tint it like
an event, and a custom `renderEvent` output replaces the default marker.
`href` or `getEventHref` makes an event a canonical link. Hover tints an
event that opens or links; it never moves the event or adds a shadow.
`accessibleDetail` adds short text to the event's accessible name for state
that its content shows only visually, such as a priority flag in a custom
`renderEvent` output.

`description` is optional plain text. The default timed-event card shows up to
two lines when its duration is at least 90 minutes; compact, all-day, and
smaller cards omit it. Applications that store Markdown or other rich text
should pass a short plain-text preview instead of the source markup.

`renderEvent(event, context)` receives the event and normalized `CalendarEventRenderContext`, including
the effective start, end, duration, time label, compact or fill state, and in
the month view the `leadingTime` to show before a one-day entry's title. In
the day and week views with `dayHours`, `context.timeline` is set; render the
title in `k2b-calendar-event__title` and the time in `k2b-calendar-event__meta`
there, so the views size them, and show `context.remaining` after the time of
the running event. `context.checkbox` says the calendar draws the event's
checkbox, so the content leaves its own out. A small icon such as a priority
flag takes `k2b-calendar-event__flag` and sits at the top right of a band.
Custom output must retain useful visible event text. Entries of the month
view and its day list are always `compact` and one line high, the height of
a lane: render a single line there, title first, or the lane cuts the rest
off. Put state that the line shows only as an icon into `accessibleDetail`.

## Views and navigation

Weekend shading follows the locale's week data in month, week, and phone month
views, with Saturday and Sunday as the fallback. Day and year views keep their
existing backgrounds without weekend shading.

`view` accepts:

- `day` for one timed column;
- `week` for seven timed columns;
- `month` for the standard month grid;
- `year` for a compact twelve-month overview;
- `mobile-month` for a bounded month picker with the selected day's agenda.
  Its weeks are compact rows at least 44 px (2.75rem) tall instead of the
  month view's full height, so the agenda follows close below the grid.

Without `dayHours`, a week needs 40 rem: 36 rem shared by its days plus the
hour gutter. A day view's single day needs 12 rem per overlapping lane.
A narrower calendar, such as one beside the detail panel or on a phone,
scrolls the hours sideways inside its rounded frame. The day and all-day rows
follow, the hour gutter stays in view, and the vertical scrollbar stays at the
frame's edge. An event or day that is selected or focused at the start edge
stops beside the hour gutter, not under it.

Limit the switcher with `views`. `getDateHref`, `getViewHref`, and
`getEventHref` keep navigation functional in the server response.
`onNavigate` progressively enhances those links after mount.

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
inner line. The arrow keys move the selection; Home and End go to the start
and end of the week, Page Up and Page Down to the same day of the previous and
next month, or to that month's last day when it is shorter; the previous and
next buttons step a month the same way. Escape closes an open popover first
and then clears the selection. A range takes a mouse or the keyboard; on a
touch screen a tap selects one day.

Without `range`, the month view shows one month and pages: the arrow keys
page at the edge of the grid, and a new month starts without a selection.

With `range`, the month view scrolls through the weeks of `range` from top to
bottom, without stops. Five rows share the height below the weekday row,
which stays in place. The week in the middle of the view sets the month in
focus by its middle day (Thursday when weeks start on Monday): the header
names that month, and the days of other months are dimmed. Each 1st names its
month, such as “Nov 1” or “1. Nov”. While the weeks glide by, a label names the
month in focus and leaves once the view rests; phones leave it out.

- The previous and next buttons, J and K, and Page Up and Page Down move one
  month and put the week with its 1st on top; quick repeated steps add up.
- Today goes to today's month the same way, scrolls on when today lies below
  the visible rows, and lets today's number pulse once. With reduced motion
  every move is instant and nothing pulses.
- Go to shows the month of its day, and that day when it lies further down.
- The arrow keys scroll their day into view, also across months. The
  selection, the focused day, and an open popover stay while the view scrolls,
  and a drag across days or of an entry scrolls at the top and bottom edges.
- The Today button points up or down until more than half of today's week is
  in view, and shows a calm dot then.

Near the first or the last loaded week, scrolling calls `onLoadEarlier` or
`onLoadLater` once for each range; extend `range` and `events` there, and keep
the shown `events` until the new ones arrive. Weeks that arrive above the view
do not move what the reader sees. A step to a month past the loaded weeks
asks for them the same way and moves there once they arrive; the reader's own
scrolling ends the wait. Return a promise from `onLoadEarlier` or
`onLoadLater` to mark an end: when it settles without moving that end of
`range`, steps past it go through `getDateHref` or `onDateChange`, as they do
without these callbacks. `onVisibleDateChange(date, last, focus)` reports the
first and the last day of the weeks more than half in view, and `focus`: the
first selected day in the month in focus, else `date` when it lies in that
month, else today when it lies there, else that month's 1st. It reports once the view opened and
whenever one of them changed, for example to keep `focus` in the URL or to
count what is in view. A `date` that names the reported `focus` keeps the
view in place; another `date` shows its month as soon as `range` covers it.
The year and the compact mobile-month views ignore `range`.

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
  place, such as at the end of a slow save, does nothing. A `close` returns
  the focus to the day only while it is still in the quick create; when the
  person moved on, the focus stays where they went and a newer selection stays
  in place. It never shifts the layout of the grid.
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
No drag in the calendar selects page text.

`mobile-month` keeps its compact picker: its days link to their agenda
through `getDateHref`, and colored dots stand for the day's events.

### Day and week views with `dayHours`

`dayHours={[6, 22]}` gives the day and week views waking hours. A day then
runs from 06:00 to 06:00 of the next day: the night after 22:00 belongs to
the day before, so an event from 23:00 to 01:30 stays one band of its
evening, and a deadline at 00:30 belongs to the evening too. An event that
crosses only the day start, such as 05:30 to 06:30, shows in both days: in
the night of the day before and at the top of its own day. Without
`dayHours` the views keep their midnight grid with `startHour`, `endHour`,
and the visible hours.

- **Nights** fold into one slim row unless an entry lies in them. A night
  with an entry opens at half the height of a waking hour below a bar that
  names it, such as "Night · Fri 9 → Sat 10", and folds again with that bar
  or, in the week view, with the moon in the hour column. A folded night
  lists its entries as chips with their time; a to-do keeps its checkbox
  there, and in the week view the arrow keys reach the chips after the
  waking hours.
- **The day view** is one scroll through the loaded days with each day's
  heading on top while the day is in view. Runs of empty days merge into one
  row, "Nothing planned", that opens them; today, the day of `date`, and a day
  that Go to finds inside such a run never fold. When loaded days join a run
  at either end, it stays the same row, so its focused "Nothing planned"
  button keeps focus. The wheel slows
  down within 72 px of a day start, and a scroll that rests within 40 px (88 px
  after a finger) glides onto it; a line at the top of the heading fills while
  the start passes. The previous and next buttons glide to the day before or
  after, Today to now in the upper third of the view.
- **The week view** is a strip of the loaded days, seven to a screen or three
  on a phone, with the hours in a column that stays on the left. A trackpad,
  Shift with the wheel, or a finger scroll it sideways; each gesture keeps the
  axis it started on, and the strip settles on the nearest day start once it
  rests. A scroll without a gesture, such as an event scrolled into view,
  settles on the next day start in its own direction, so what it brought into
  view stays there. The previous and next buttons move to the start of the week before or after,
  and Today returns to this week, on a phone to today within it. Nights open
  for the whole strip when an entry of the shown week lies in one. The all-day
  row is as high as the weeks in view need, so a week that loads off screen
  moves nothing. It opens at the start of the week of `date`, or on a phone
  at that day within its week.
- **Entries.** Timed events are bands as long as they last, side by side when
  they overlap, with their time; the running one fills up with the time that
  passed and says what is left, such as "27 min left". `display: "marker"`
  draws a deadline with a time as a dashed line with a pill; pills that
  would cover each other, such as two to-dos due at 17:00, sit side by side,
  the earlier one on the left, and each line stays at its own time. An all-day
  event, a timed event that runs past the start hour of a later date, and a
  date-only marker sit in the all-day row; in the week view a long event is one bar per week with a torn
  edge and, where it has room, "from 20" and "until 27".
- **Checkboxes.** An event with `checked` shows a checkbox before its title,
  drawn by the calendar; `onEventCheck(event, checked)` makes it a control,
  and Space on the entry checks it as well. The check draws itself and the
  title strikes through until the host's events agree; when `onEventCheck`
  returns a promise that rejects, the box goes back. When the reader checks
  off the last open entry due today, today's heading says "All done for
  today" for about two seconds, in the place of its note, so nothing moves.
- **Free time** between the timed entries of the waking hours is labelled
  from an hour on, such as "1 hr 15 min free", and stands out from three
  hours on. Shorter free time shows only while something is dragged into it. Activating it opens `renderQuickCreate` with that time, or calls
  `onSlotActivate` without it: a gap up to two hours whole, a longer one for
  an hour from its start, and a free morning from 09:00. In the week view
  free time shows in the column under the pointer or the focus, or after a
  tap on a touch screen. A click on empty time selects an hour, a
  double-click or a drag creates; a second tap on a touch screen proposes an
  hour with handles for its start and end. Drawing shows the live length,
  such as "14:00–15:30 · 1 hr 30 min", on 15 minutes, with Shift on 5.
- **Dragging in.** `controller.dragIn(event, item, onDrop)` follows a pointer
  that pressed an entry outside the calendar, such as a task in a list below
  the day view: the entry follows the pointer, the free time under it says
  "fits" or how much is missing, and `onDrop` receives the time where it is
  released. A mouse drags at once, a finger after a long press. Mark the
  element the finger holds, such as the list row, with
  `data-calendar-drag-source`: it lifts while it is held, and the stylesheet
  turns off text selection and the system's long-press callout on it, so a
  link preview cannot take the hold over. A hold that ends without a drop
  leaves the page scrolling as before. `dragIn` stays the calendar's own drop into free time; [`DragSource` and `DropTarget`](../actions/drag-and-drop) handle drops elsewhere.
- **Now** is a line across the day with the time beside it; the header of the
  day says what starts within the hour, such as "Planning in 12 min".

`range` names the days of `events`, from `from` up to `to`, which is
exclusive: the start of the day after the last one. Without it the views
cover the day or the week of `date`; the month view reads it as described
above. Near the first or the last loaded day, scrolling toward it calls
`onLoadEarlier` or `onLoadLater` once for each range; extend `range` and
`events` there. Days that arrive above the view do not move what the reader
sees. `onVisibleDateChange(date, last, focus)` reports the first and the last
day on screen, with the first as `focus`, once the view opened and whenever
scrolling changed them, for example to keep the first in the URL or to count
what is in view; the header title, the view switcher, and the previous and
next links follow the first too. A `date` outside `range` puts its day on
screen as soon as `range` covers it, so a host may change `date` first and
load the days after. A `date` that names the first day on screen keeps the
reader's place, so a host that writes the reported day back into `date` does
not move the view.
`onSelectionChange` reports a selected hour or day of these views as it does
the month's days.

The server renders the shown day or week; the views take their first
position once they mount.

### Shortcuts and the Today button

In the day and week views with `dayHours`, the Today button shows an arrow
toward today, left or right in the week and up or down in the day view, or a
calm dot while today is on screen. The continuous month view points up or
down until more than half of today's row is visible. The icon keeps its
place, so the button never changes its width. Paged month and the other
views keep a plain Today button.

`onCommandsChange(commands)` receives the calendar's commands for the host's
shortcut dispatcher, command palette, and help: Today (H), Next (J),
Previous (K), the views (1 to 4), and Go to (G), which reads a date such as
"3/15", "15.3.", "March 15", or "2027-03-15", a weekday such as "Friday" or
"next Fri", a month such as "March", or a week number such as "W 12", in
English or German. Pass the application's own in `commands`, such as New
event (N); the calendar includes them. With `onCommandsChange` the header
shows a keyboard button where a pointer can hover, which opens a dialog with
the same list and the arrow keys beside J and K. `controller`
receives `quickCreate(create)`, which opens the quick create where a new
entry fits (the selection, today at the next full hour while today shows, or
09:00 of the first shown day), and `createTarget()`, which returns that
time. The year view has no quick create, so `quickCreate` does nothing there.

While the month's quiet quick create waits for typing, the calendar publishes
its commands and those of `commands` without their single keys, so the first
letter typed at a selected day starts the title; Ctrl and Meta combinations
stay. With `onCommandsChange` the left and right arrow keys page like K and J
while the keyboard is in the calendar or nowhere, unless something there uses
them, such as the grid of the week or the month, or a text field.

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

The day and week views mark their own scroller with `k2b-detail-trail`, so
applications add nothing beside an
[AppWorkspace detail panel](/en/ui/layout/workspace#detail-and-panel).
Without `dayHours`, that is the hour scroller,
`k2b-calendar-time-grid__scroll`; with `dayHours`, it is the strip of days
in the week and the stream of days in the day view.
Under an open waiting drawer, the week keeps the width of its days and
scrolls sideways, with its day header and all-day row. Selecting an event
scrolls its day out beside the drawer. With `dayHours`, the strip then
settles on the next day start or day end at the drawer in the direction it
scrolled, never back over the event, so the event stays whole beside the
drawer, also in a lane of overlapping events. The day view narrows into the space beside the drawer, so the hours
stay in view. Without `dayHours`, a day with three or more overlapping events
scrolls at 12 rem per lane. The month view keeps its full width under the
drawer.

## Interaction

The following callbacks enable matching interactions in browser code:

- `onEventDrop` moves an event;
- `onEventResize` changes an event duration;
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
On a phone the title keeps only its own width: Today and the actions sit at
the end of its row, so a shorter title moves nothing either.
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
  checked?: boolean; location?: string; calendarName?: string;
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
  timeLabel: string; leadingTime?: string; remaining?: string; checkbox?: boolean; timeline?: boolean;
};

type CalendarRange = { from: Date | string; to: Date | string };

type CalendarCommand = {
  id: string; label: string; shortcut?: string; description?: string; icon?: string; run: () => void;
};

type CalendarExternalDrag = {
  title: string; color?: CalendarEventColor; colorHex?: string; minutes: number;
};

type CalendarController = {
  quickCreate: (create?: string) => void;
  createTarget: () => CalendarEventTimeChange;
  dragIn: (event: PointerEvent, item: CalendarExternalDrag, onDrop: (slot: CalendarEventTimeChange) => void) => void;
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
  withWeekNumbers?: boolean; startHour?: number; endHour?: number;
  dayHours?: readonly [start: number, end: number]; range?: CalendarRange;
  onLoadEarlier?: () => unknown; onLoadLater?: () => unknown; onVisibleDateChange?: (date: Date, last: Date, focus: Date) => void;
  visibleStartHour?: number;
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
  onEventCheck?: (event: CalendarEvent, checked: boolean) => void | Promise<unknown>;
  onSelectionChange?: (range: CalendarEventTimeChange | null) => void;
  selectionMenu?: (range: CalendarEventTimeChange, controls: CalendarSelectionControls) => readonly DropdownItem[];
  renderQuickCreate?: (range: CalendarEventTimeChange, controls: CalendarQuickCreateControls) => JSX.Element;
  toolbarActions?: JSX.Element; toolbarContent?: JSX.Element;
  commands?: readonly CalendarCommand[]; onCommandsChange?: (commands: readonly CalendarCommand[]) => void;
  controller?: (controller: CalendarController) => void; class?: string;
};
```

Dates accept `Date` or parseable strings. Prefer date-only strings for calendar days and offset-bearing ISO instants for timed events. Recurrence is metadata; the host supplies the occurrences to display. `dayBadges` is keyed by `YYYY-MM-DD`. `dateConfig` uses [DateContext](/en/ui/content/intl#date-and-locale-options).

Defaults: `view="month"`, week starts Monday unless overridden, `visibleStartHour=0`, `visibleEndHour=24`, `startHour=8`, `endHour=18`, and `allDayMaxHeightRem=7`. Visible hours bound the grid; start/endHour mark business hours. Boolean features are opt-in except the single-click activation defaults described above. `onNavigate` uses [LinkNavigateEvent](/en/ui/getting-started#icons-tones-and-navigation); `onNavigateHref` is the separate string callback without a document view transition. `onPrefetch` receives the canonical URL to preload. Callbacks do not persist edits.

## Accessibility

Canonical links remain available before mount. Date cells, navigation,
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
default, and at once when the person prefers reduced motion. With `dayHours`
they open at now in the upper third today, else an hour before the first
entry of the day; gliding and settling are instant under reduced motion, and
the checkbox and fill animations stop.

In the week view with `dayHours` the grid is one tab stop: the arrow keys move
between the day headings, entries, and free time of a column and to the
nearest stop of the next column, Home and End go to the first and last stop
of the column, Enter opens or creates, and Space checks off. Free time of
less than an hour, which the column hides, is no stop. The day view keeps
every entry and every gap of an hour or more in the tab order, in time order;
Tab into it starts at the first stop on screen, and Space on an entry with a
checkbox checks it off.

Where a view supports dragging, editable entries support mouse dragging and
touch dragging after a 420 ms hold. The held entry or grip highlights before
dragging. Before the hold, swiping keeps native scrolling; moving more than
10 px or releasing cancels the hold. Hold a resize grip to change the start
or end where that view supplies grips. Release commits; Escape, pointer
cancellation, the window losing focus, or removing the view cancels. A completed
hold suppresses its trailing click. Month view moves entries by calendar day;
its duration editing is available through the keyboard.

With focus on an editable entry, **Alt+Left/Right** moves it one calendar day.
Timed entries in day and week views also support **Alt+Up/Down** to move by
15 minutes. Add **Shift** to either shortcut to change the end instead of
moving the entry; the end must stay after the start. All-day and month
entries use day increments. Moving by a day follows `dateConfig` and
`timeZone`, including clock changes; moving a timed entry preserves its
elapsed duration. These shortcuts call `onEventDrop` or `onEventResize` and
require the matching callback. They do not expand the calendar's loaded
range. Entries expose the available instructions through their localized
accessible description. Ordinary arrow navigation, Enter to open, and Space
to check remain available. `editable: false` removes editing instructions and
suppresses mouse, touch, and keyboard edits while retaining activation.

## Runtime

All views, labels, dates, and links render on the server. Drag, resize,
pointer-slot selection, day selection, the month menu and popovers, measured
month lanes, prefetch, and callback navigation require browser code. With
`dayHours` the server renders the shown day or week; the earlier loaded days,
the first scroll position, the stops, the sideways strip, free-time actions,
and dragging in require browser code.

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
