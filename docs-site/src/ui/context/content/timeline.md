# Timeline

`Timeline` shows time as one continuous filmstrip: waking hours are
proportional, so duration, free time, and the evening show at a glance, while
nights and days without timed items fold into narrow strips. Time runs across
days without paging. Wide containers show the strip horizontally; narrow ones,
such as phones, show the same strip vertically.

The application owns the items, the loaded range, what activating an item
does, and who may check a task. The component owns the layout of time,
scrolling, the reading position while days load, and keyboard and screen
reader access.

## Import

```tsx
import { Timeline, type TimelineColor, type TimelineController, type TimelineItem, type TimelineProps } from "@k2b/ui";
```

## Use Timeline

Pass the loaded `items`, the range with `from` and `to` (exclusive), and the
time zone with `timeZone` or `dateConfig`. The view starts at `from`, so
choose the first time the reader should see, for example yesterday evening.
Give the timeline a bounded height, such as the growing part of a flex
column, and place it on a surface: day headings use the surface color.

To offer the timeline as one view of a [Calendar](/en/ui/surfaces/calendar),
add it with `customViews` and render it as the calendar's body.

Without `now`, the timeline reads the clock and moves the now line every 30
seconds. Pass `now` for a fixed time, for example in tests. The server and
the browser read their own clocks, so a page rendered just before midnight
can hydrate on the next day. Where that matters, pass the request's time as
`now` and update it in the browser if the now line should move.

### Items

Every `TimelineItem` has a unique `id`, a `label`, and a `start`:

- With an `end` after `start`, the item is a band whose length is its
  duration. Without `end`, or with `kind: "marker"`, it is a point in time,
  such as a deadline, drawn as a dashed line with a label. A band that starts
  before `from` or ends after `to` shows only its loaded part, but its label
  keeps its own times.
- `allDay: true` puts the item in the all-day row above the strip. A
  date-only `start` such as `"2026-10-08"` is that day in the time zone; an
  `end` at midnight is exclusive.
- `color` takes a token of the calendar palette (`blue`, `emerald`, `amber`,
  `red`, `violet`, `cyan`, `zinc`) or a hex color such as a label color.
- `detail` is short extra text, such as a place or a category. It is read
  with the item and shown where there is room.
- `checked` adds a checkbox, for example for a task. Leave it out for items
  without one.
- `href` makes the item a link; otherwise it is a button.

### How time is laid out

Waking hours from 06:00 to 22:00 take 54 px per hour, 48 px on the vertical
axis. Every night from 22:00 to 06:00 is one narrow fold, and a run of days
without timed items in their waking hours is one fold that says "Nothing
planned". Today always stays open, and so does a day at either end of the
range whose waking hours are loaded only in part. Items inside a fold show as
small time markers in it, up to three; from a fourth on, all but the first
two collapse into a "+n" entry in the third place.

Overlapping bands share up to three lanes. Where more overlap, the extra
bands and the ones they meet in the third lane collapse into a "+n" entry
there. All-day items get two lanes in the same way; the days of a fold share
one place, so all-day items on different days of one fold can collapse
together. Free time of an hour or more between bands is labelled, in half
hours; three hours or more stand out.

A "+n" entry opens a menu of its items with their times, or "All day" and
their days. A row opens its item as a click on it does, also as a link with
modified clicks when the item has `href`, and shows a checkbox state where
the item has one. An item that cannot be opened but whose checkbox the reader
may change gets a checkbox row instead.

Positions come only from the times and the items, never from measurement, so
nothing moves when the page hydrates, fonts load, or the now line advances.
The now line moves with a transform.

### Axis

The axis follows the width of the timeline itself: wider than 40rem it runs
horizontally, otherwise vertically. The stylesheet decides with a container
query, so the server response already has the right axis. On the vertical
axis every day starts with a sticky heading and, where it has all-day items,
an all-day row; all-day items that cover several days repeat there.

### Load more days

Set `onLoadEarlier` and `onLoadLater` to load days when the reader nears
either end. The timeline calls each once, and again once `from` or `to` moved
and changed the strip's length. Days that only fold into the fold at that end,
such as an empty week, leave the strip as long as it was, so the timeline
asks for that end again only after the reader has scrolled more than a screen
away and come back; an empty calendar does not load week after week on its
own. Extend the range and add the items of the new days together, in one
`batch`; what the reader sees stays in place, to the pixel, also when days
load at the start. Days fold only once their waking hours are loaded, so an
empty weekend at the edge does not change size later. Where the view starts
in a night or a fold at the start of the range, which spreads over other
times once earlier days load, everything from the end of that night or fold
stays in place.

While the reader scrolls or has a finger on the strip, and while a smooth
scroll the timeline started itself through the controller or keyboard focus
runs, a change that would move what they see waits until the scroll rests: a
scroll write can stop a smooth scroll or fight touch momentum, as on iOS. Changes after the visible start, such as
days loading at the end or a checked task, apply at once. Return a promise to
have the timeline wait for it before it asks again, and set `busy` while a
load runs.

### Scrolling

Trackpads, touch with its momentum, and pinch-zoom stay native; the timeline
adds no touch handling. Sideways overscroll does not turn into history
navigation. A mouse wheel scrolls a horizontal strip sideways only when
nothing around it scrolls vertically, so the strip is the view's scroll
area; inside a scrolling page the wheel scrolls the page, and Shift with the
wheel scrolls the strip. The timeline decides this once per wheel gesture. A
wheel's notches glide; small steps, such as a trackpad's, follow at once.
A vertical strip without a bounded height scrolls with the nearest scrolling
area around it, which then keeps the reading position too.

The `controller` callback receives `scrollToTime(time, { align })` and
`scrollToNow()`, for example for a "Today" button. Scrolling is smooth unless
the reader prefers reduced motion, and days that load meanwhile do not stop
it short of its target.

### Activation and checkboxes

`onActivate(item)` runs on a click, Enter, or Space. A modified click on a
link keeps its browser meaning, such as opening a new tab. `onToggle(item,
checked)` runs on a click on the checkbox or Space; leave it out when the
reader may not change the item, and Space opens the item instead. Update
`checked` in `items` to show the new state.

## Accessibility

The timeline is a region named by `label` (default "Timeline"). Every day
has a heading, level 3 unless `headingLevel` says otherwise, and an ordered
list: all-day items first, then timed items by start. Each item is named
with its time, detail, day, and checkbox state, for example "Release planning
4.2, 16:00 to 17:30, Room Schlei, Thursday, October 8". Folds, hours, free
time, and the now line are hidden from assistive technology.

The timeline is one tab stop, at first the item happening now or next. The
arrow keys along the axis (Left and Right, or Up and Down on the vertical
axis) move to the previous or next item, also across days. Page Up and Page
Down go to the first item of the previous or next day, Home and End to the
first or last item of the day, and T to the item happening now or next. Day
and now jumps are announced. Focus scrolls only as far as needed. A
description of these keys is attached to the region. When the focused item
is drawn anew, moves behind a "+n" entry, or goes, focus stays in the
timeline: on the item, on the "+n" entry that holds it, or on its nearest
neighbour.

## Runtime

The server renders the first 3,200 px of the strip and the day that holds the
tab stop. In the browser, the timeline renders the days near the visible area
plus one screen on either side, and the focused day; a year of items mounts
in well under a second. Without days to show, the scroll area itself is the
tab stop.

## Example

```tsx
const [range, setRange] = createSignal({ from: yesterdayEvening(), to: nextWeek() });
const [items, setItems] = createSignal<TimelineItem[]>(initialItems);
let timeline: TimelineController | undefined;

<Button onClick={() => timeline?.scrollToNow()}>Today</Button>
<div style={{ display: "flex", "flex-direction": "column", height: "36rem" }}>
  <Timeline
    items={items()}
    from={range().from}
    to={range().to}
    timeZone="Europe/Berlin"
    label="Product team timeline"
    onActivate={(item) => openDetail(item.id)}
    onToggle={(item, checked) => saveTask(item.id, checked)}
    onLoadEarlier={async () => {
      const from = weekBefore(range().from);
      const earlier = await loadItems(from, range().from);
      batch(() => {
        setItems((current) => [...earlier, ...current]);
        setRange((current) => ({ ...current, from }));
      });
    }}
    controller={(controller) => (timeline = controller)}
  />
</div>;
```
