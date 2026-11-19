# ActivityList

`ActivityList` shows what happened to an object as a vertical timeline: the
newest entry at the top, the start at the bottom. A 2 px rail runs through
the middle of the avatars. Dashed dividers name "Today", "Yesterday", and each
day of the last week; everything older stands under one divider "More than a
week ago".

`ActivityCard` puts the list on a detail page as a section with "History"
and, when there are more rows than fit, "All N" at the end of the heading.
"All N" opens the full history as a dialog with a filter by kind.

## Use ActivityList and ActivityCard

Use them for every history of an object or a place: changes, sent messages,
approvals, comments. Put `ActivityCard` on a detail page, `ActivityList` in a
side column or on a page of its own, and `openActivityDialog` behind a menu
entry. Use `Timeline` for planned time (a calendar as a filmstrip),
`Discussion` for comments people write, and `ChangeList` for changes that
wait to be saved.

## Import

```tsx
import { ActivityCard, type ActivityEntry, ActivityList, openActivityDialog } from "@k2b/ui";
```

## An entry

```tsx
const entry: ActivityEntry = {
  at: "2026-11-12T08:31:00+01:00",
  icon: "ti ti-mail-x",
  tone: "danger",
  text: "Invitation not delivered",
  detail: "team@stadtpark.example · Mailbox full",
  action: { icon: "ti ti-send", label: "Send the invitation again", onClick: resend },
  kind: "mail",
};
```

- **One row:** a 24 px `Avatar`, the actor and sentence in 14 px, then the
  time in 13 px on the right. Pass `avatar: { name, kind, src? }` for identity: `person` keeps profile
  pictures or coloured initials, `service` shows a neutral square robot, and
  `system` shows a neutral gear for automatic events; `deleted` shows a neutral
  person-off glyph for deleted people. Without
  `avatar`, string actors get initials and JSX actors keep a neutral glyph. Without an actor, the row reads
  "Automatic" with a neutral system avatar. Within the last week the time
  names the hour alone, before that the day and hour.
- **Surface:** timeline avatars align with the surrounding section title. One
  bleed, `--k2b-activity-bleed`, sets how far the row surface reaches past the
  content edge on both sides: the list's outer margin, the row's inline
  padding, the rail, and the day line follow it. Timelines in a section, a
  panel, or a dialog bleed 0.5rem, so the surface keeps at least 6 px from a
  framed section's edge. A feed row outside a list, as in Mail, keeps 0.75rem,
  and feed owners keep the Mail list's 0.5rem surface inset. Rows use
  `--k2b-radius-control`, the FileGrid list's 0.5rem / 0.75rem padding, and
  Mail's 2.75rem single-line minimum height.
  Hover uses the translucent `--k2b-app-workspace-hover`, so elevated and
  base surfaces both respond. Only `Row selected` uses `--k2b-row-selected`;
  expanding details leaves the surface unchanged.
  Hover, focus, and selection change only paint.
- **Icons:** ordinary kind and success icons are redundant with the sentence
  and stay hidden. Warning, danger, or an explicit `iconLabel` retain a
  small status mark at the avatar, outside the text axis. `icon` is optional;
  warnings and failures without one use a 12 px alert glyph outside the initials.
  The marker's 2 px ring follows the row fill; warning and danger details use
  `--k2b-warning-text` and `--k2b-danger-text`.
- **Text:** write a standalone event phrase after the actor separator, for example
  "Mira · Reply sent", never a predicate that continues the name ("Mira · has sent").
  Sentences wrap in full, including on a phone. They have no
  tooltip or native `title`. Dates expose their full instant and distance
  as screen-reader text, without a hover hint.
- **Rarely below:** one `detail` line (a result, the reason of a failure, a
  quote, or "before → now" with `ActivityList.Change`) and at most one
  `action`. An action with `href` is a link, otherwise a button.
- **Click:** `href` makes the sentence a link to the entry's object; a
  click anywhere on the row follows it, and a middle click or a click with
  Ctrl, Cmd, or Shift opens it in a new tab. `onOpen` opens the entry
  in place, such as its dialog; `details(all)` folds out more below it. A
  click anywhere on the row acts like the sentence, but not on links,
  buttons, or fields inside the row, not inside folded-out details, and not
  when it ends a text selection. Use `href` rather than a link inside
  `text`, so the whole row stays the target.
- **Bundles:** entries with the same `bundle.key` and the same text `actor`
  right after each other on the same day become one row;
  `bundle.text(count, all)` says it with the count ("Draft changed 4 times").
  A bundle keeps the detail line only when it is the same text for all its
  entries.
- **Key:** `id`, such as the record's id, keeps a row with its folded-out
  details and focus when the entries are built anew, such as after a
  refresh. Without it the entry object is the key. Keep it unique in the
  list.
- **Focus:** every row is a focus target with `tabindex="-1"`, outside the
  tab order. Put a `data-*` attribute on it with `attrs`, and move focus there
  after a reload, such as after "Send again".

## A row inside VirtualFeed

`ActivityList.Row` renders the same row as a `div`, without a timeline or day
dividers. The feed owns ordering, grouping, pagination, and the clock. Pass
`now` from the server and update it in the parent when relative time should
advance; each row creates no timer. `selected` marks the currently open
object. `onNavigate(event)` handles its sentence link, including Enter;
leave modified clicks untouched so the browser can open another tab.

```tsx
<VirtualFeed anchor="start" items={entries()} getKey={(entry) => entry.id!}
  estimateSize={() => 44} label="Mailbox events">
  {(entry) => <ActivityList.Row entry={entry} now={data.now}
    selected={entry.id === selectedId()} onNavigate={(event) => navigate(event)} />}
</VirtualFeed>
```

Mail's **Ereignisse** tab uses this row inside `VirtualFeed`. Its feed owns sticky
day groups and pagination, so it intentionally has no timeline rail or dashed
day headings. The row surface, identity, sentence, and accessible time stay shared.

Use the Mail list's 0.5rem inset around each feed row.
Keep application filters outside the row; a mailbox may filter on the server
and preserve those filters in the URL.

## Densities

- `density="compact"` (default) for a card or a side column.
- `density="wide"` for a dialog or a page, at most 80rem wide.

Both keep the avatar, sentence, and time in the same columns. In compact lists,
the actor name stays on one line with an ellipsis; the complete name remains in
the accessible text without a native tooltip. Wide lists wrap the full name.
Long event sentences wrap beside the time.

`limit` shows only the newest rows; the rail then fades out below them. Pass
`more` when further pages follow, for example above a `LoadMore`.

The rail pauses behind each avatar instead of being covered, so the list looks
the same on any surface: a page, a card, a dialog, or a sheet. The list also fits a container sized by its content, such as a popover.

## Time

Days count in the application's time zone: pass `dateConfig` or `timeZone`
(UTC without them). Pass `now` from the server, so the server and the first
browser render show the same text; the browser then moves the clock on every
minute. Only times and dividers change on that tick; bundle sentences,
folded-out details, and focus keep their nodes.

## States

- `ActivityList.Loading`: three quiet rows on the rail, announced as a status.
- `ActivityList.Empty`: one sentence, "Nothing has happened yet." by default.
- `ActivityList.Error`: one sentence with "Reload".

`ActivityCard` takes `entries={null}` while nothing has loaded yet, with
`loading` or `error` and `onReload`. An error while entries are there stands
above the list, and the list stays. `lead` puts a quiet line above the
timeline and replaces the empty text.

## The card and the dialog

`ActivityCard` shows 6 rows. Its title is a second-level heading; pass
`level={3}` when the card stands under a section heading of the page. "All
N" counts rows, bundles as one. The dialog
shows the list in the wide density, `subtitle` under its title, and a filter
by `kinds`. The `ChoiceChips` filter counts entries, not rows, shows only kinds with
entries, and appears only from three choices on ("All" and two kinds). The
chips scroll horizontally on a phone. The dialog keeps a stable height of
`min(40rem, 70dvh)` and its inset `ScrollArea` fills the remaining space.
The heading, filters, and equal side margins stay in place while filtering.

Build `entries` in a getter, never in `createMemo`: sentences and details are
JSX, and the card and the dialog each need nodes of their own.

```tsx
<ActivityCard
  entries={entries()}
  now={data.now}
  timeZone={data.timeZone}
  subtitle="Summer party"
  kinds={[
    { key: "mail", label: "Emails" },
    { key: "change", label: "Changes" },
  ]}
/>
```

`openActivityDialog({ entries: () => entries(), title, subtitle, kinds, now })`
opens the same dialog from anywhere, such as a menu entry "Show activity";
`icon` puts the menu entry's icon beside its title.

## Accessibility

The list is an ordered list named "History" (`label` changes it). Dividers
are hidden from screen readers; each row's `<time>` carries the full instant
and relative distance in screen-reader text. An icon with a meaning the sentence does not say takes
`iconLabel`, such as "failed" on a red icon. A row with `href` renders its
sentence as a link; a row with `onOpen` or `details` as a button, with
`aria-expanded` for `details`. The loading state is a `role="status"`, the
error a `role="alert"`.

## Runtime

The server renders the list, the card, and "All N" from `now`, so the first
browser render shows the same rows and dividers. In the browser the clock
moves on every minute. The dialog opens through `prompts.dialog` and needs a
browser; it reads `entries()` when it opens.

## Example

```tsx
const entries = (): ActivityEntry[] =>
  data.events.map((event) => ({
    at: event.at,
    icon: event.kind === "mail" ? "ti ti-mail" : "ti ti-pencil",
    text: event.kind === "mail" ? "Sent by email" : "Draft changed",
    bundle: event.kind === "mail" ? undefined : { key: "draft", text: (count) => `Draft changed ${count} times` },
    actor: event.person,
    avatar: { name: event.person, kind: "person", src: event.avatarUrl },
    kind: event.kind,
  }));

<ActivityCard
  entries={entries()}
  now={data.now}
  timeZone={data.timeZone}
  subtitle={data.project.name}
  kinds={[
    { key: "mail", label: "Emails" },
    { key: "change", label: "Changes" },
  ]}
  error={failed()}
  onReload={reload}
/>;
```
