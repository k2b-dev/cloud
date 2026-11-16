# ActivityList

`ActivityList` shows what happened to an object as a vertical timeline: the
newest entry at the top, the start at the bottom. A 2 px rail runs through
the middle of the icons. Dashed dividers name "Today", "Yesterday", and each
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

- **One row:** the icon of the kind (20 px, grey, without a circle), one
  sentence in 14 px, and the meta line "time · distance · person" in 13 px.
  `actor` is a text of the application; without one the meta line reads
  "automatic". Within the last week the meta names the time alone, before
  that the day and the time.
- **Tone:** only the icon carries it: `success` for a completion, `warning`
  for a notice, `danger` only while an action is needed.
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

## Densities

- `density="compact"` (default) for a card or a side column: the meta line
  under the sentence.
- `density="wide"` for a dialog or a page: the meta line on the right of the
  first line, the list at most 80rem wide. Narrower than 34rem, the meta goes
  under the sentence again.

`limit` shows only the newest rows; the rail then fades out below them. Pass
`more` when further pages follow, for example above a `LoadMore`.

The rail pauses behind each icon instead of being covered, so the list looks
the same on any surface: a page, a card, a dialog, or a sheet. Only the wide
list measures its own width, so a compact list also fits a container sized
by its content, such as a popover.

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
by `kinds`. The filter counts entries, not rows, shows only kinds with
entries, and appears only from three choices on ("All" and two kinds).

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
opens the same dialog from anywhere, such as a menu entry "Show activity".

## Accessibility

The list is an ordered list named "History" (`label` changes it). Dividers
are hidden from screen readers; each row's `<time>` carries the full instant
as its tooltip. An icon with a meaning the sentence does not say takes
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
