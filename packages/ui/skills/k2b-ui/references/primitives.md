# Primitives and components of @k2b/ui/v2

Every part marks its root with `data-k2-part="<Name>"`; that name is what
`describeV2` prints. No part takes `class`, `style`, `size`, `gap`,
`padding` or `density`. Shared types: `Action = { label, icon?, href?,
onNavigate?, onClick?, meta?, forward?, disabled? }`, `Width = { min, default }` (px), `Status =
"ok" | "warn" | "bad"`, `Person = { name, initials?, color?, image? }` (`image` is the address of a picture). Icons are
Tabler names without `ti-` (`plus`, `package`).

**Links that open in place.** Every `href` stays a real `<a href>`: it works
before the page is live and opens in a new tab with a modifier key. Beside
it, `onNavigate` (type `OnNavigate`, the `LinkNavigateEvent` of
`@k2b/ssr/nav`) opens the page in place on a plain click or Enter; the
handler moves history with `push` or `replaceWith`, or loads the page with
`fallback`. It exists on `Row`, `Tabs` and `Nav` items, `Action` (so on
`Workspace primary` and every action as data), `Button`, `Chip` and the
`open` target of a `Table`. Never use `onClick` for what has an address.

## Frame

### Workspace

The working surface of an app: one per screen.

- `sidebar` (usually `Nav`), `sidebarWidth` (default 200–248), `sidebarLabel`
  (name of its grip).
- `head`: a `Bar` across the main column (56 px).
- `primary`: the main `Action`. It floats bottom right on the phone only;
  also put the same action as `Button variant="primary"` in the head end.
- children: a `Pane` or a `Pane.Split`, written as JSX inside the Workspace
  (a pane made before it, kept in a variable, is not counted).
- `detail` (`true` or the detail's minimum, default 400) when a detail opens
  beside the columns; `detailEmpty={{ icon, text }}` stands in its place while
  none is open, so nothing moves when it opens. Keep the list's `width`.
- Tablet: where the sidebar at its default does not fit beside every column
  at its minimum, it becomes a drawer with a button at the start of the head.
- Phone (< 768 px): the sidebar leaves, head actions hide unless `keep`.

### Pane

A column that scrolls, with no padding: everything in it reaches both edges.

- `head` (a `Bar` or `Tabs`), `status` (what stays under the head while
  the column scrolls: a `StatusRow` of 52 px above a list, or a `Bar` of 40 px
  with the state of an open entry above a reader), `label`.
- `width={{ min, default }}`: only inside `Pane.Split`; puts a grip on its
  line.
- `detail`: the reader beside a list. What is open belongs in the address:
  render the detail only while the address names an entry. On the phone
  the detail is the page, and the title in its head is never cut: beside the
  actions the head keeps it takes a second line.
- `back` (an `Action` with `href`: the list's address without the open
  entry, such as "Posteingang"): the way back on the phone, one bar above
  the detail (the part `Back`). With `back`, the head's close × needs no
  `keep`: it gives way on the phone like the other head actions. A long name (a search) is cut with "…" on
  one line; the whole name stays its accessible name and its hint. A detail
  that closes in place returns the focus to the row that opened it.
- `scrollKey` (such as "mail-list"): back and forward bring the column
  back to where it was scrolled.
- `side`: the info column of a record; quieter sections, a `more` link
  becomes a row.
- children: bands, sections, groups, lists, tables, notices, `Text`.

### Pane.Split

Panes side by side (list | reader, main | side). One hairline between, a
grip where a pane has `width`. A `Pane.Split` may stand inside a `Pane`
under that pane's `Tabs` head, after content that spans both columns (see
`record.tsx`).

Until v2 has a `Dialog`, a screen "with the dialog open" shows the dialog's
form as one more `Pane detail` at the end of the split: a head `Bar` with
its title and a close button, `Band`s of fields, a footer `Bar`. Mark it
with a `k2b-ui gap` comment. `detail` makes it leave on the phone, where the
form is its own route. Its confirm button is a default (framed) button: the
page's one primary stays in the head, and `Workspace primary` must never
confirm a dialog. When the list beside it is a table, give the dialog pane
a `width` so the table keeps its columns.

### Bar

A bar of fixed height with one line below: `start`, `end`. Height comes
from the place: 56 as a head, 52 as a status row, 40 inside a pane. Put
`Text`, `Tabs`, `RecordHead`, `Inline`, `Button`s, `Avatar` in it. Text in
a bar is cut to one line. Inside a pane a bar stands at the top (a line of
state under the head, as in `mail.tsx`) or directly after the fields it
serves (the buttons of a form or of a reply), never between entries. A line
of state that must stay while the reader scrolls goes into the pane's
`status` instead (40 px, as in `mail.tsx`). In a
column narrower than 480 px, a bar inside a pane whose `start` is an
`Inline` wraps: its things and its `end` flow as one line, one line stays
40 px, and only a second line makes the bar higher; a bar in `status` too.
A head and a status row keep their height.

### Band

A block of free height with one line below. `tone`: `note`, `ai`, `yours`,
`bad`, `warn` (meaning only). Holds `Text`, `Row`, `Prose`, `Tiles`,
fields. A message in a thread is one `Band`.

### Cells and Cells.Cell

2–4 equal cells with a line between; stacked on the phone. A cell:
`icon`, `color` (data colour of its area), `label`, `value`, `meta`,
`href` (adds a chevron). Use for the key statements of a record.

### Tiles

Like things to press, such as attachments: `items: { icon, title, meta?,
href? }[]`, `more` (an action after them), `label`. Never nested.

### Canvas

The only place for own drawing and own CSS (a map, a chart). `label`
(required), `height` in px. It must stand directly in a primitive
(`<Band><Canvas …/></Band>` or directly in a `Pane`), never as a
component's root and never in a plain element.

## Structure

### Section

A titled part: `icon`, `color` (icon on a tinted tile), `title`, `count`,
`actions` (≤ 2 text buttons in the head), `summary` (one sentence),
`more` (one link at the end: "All deliveries ›"; its `meta` shows only in a
`Pane side`, where the link becomes a row), children. No line under
the head or between entries, one line at the end. Put `Row`s directly in a
section, or a `Digest`, `Facts`, `Group`s.

### Group

What belongs together, framed: `icon`, `color`, `title`, `count`, `meta`
(head grows to 56), `state` (a `Chip`; for a running state such as "Läuft"
`state={<Text weight="medium"><Icon name="gavel" /> Läuft</Text>}`; or an amount),
`actions` (text buttons),
`menu` (more deeds behind "…"), `folded` (head only, with a chevron),
children. No line inside; never a `Group` in a `Group`, and never in a
`Band` (the band's line would cut the frame). Groups stand in a `Section`
or directly in a `Pane`. A group's way (arrived → … → paid) is `Steps`
inside it.

## Content

### List and Row

`List` holds `Row`s (`label` names it). A `Row`:

- `lines`: 1–3 texts. 1 line 40 px, 2 lines 52 px (second quiet), 3 lines
  72 px (mail: sender, subject, preview).
- lead: `icon` + `color`, or `avatar`, or a dot when `unread`.
- `meta` (quiet note after the title, a count), `time` (top right). Title
  and `meta` share the first line in equal parts, and each takes only what
  it needs: a count or a number stays whole, a long note is cut with "…",
  and the title breaks only when it is longer than its part.
- `marks` (chips, icons, avatars bottom right): use them with 3 lines; on a
  2-line row they add a third line. The third line shares its width with
  the marks, so keep it a preview text that may be cut, never an amount.
- `action` (one framed button at the end; under the text on the phone),
  `end` (a few icon buttons, or the state chip of a one- or two-line row).
- states: `unread`, `strong`, `current` (the open one, app tint),
  `yours` (you are next).
- `select: { selected, onChange }`: the row stands in a selection (pair it
  with `StatusRow select` and `selection`). A box in the lead, named by the
  title, takes the place of the symbol, person or dot; a selected row is
  blue, also while it is `current`; `yours` and `selected` share that blue
  tint on purpose. Give it to every row of the list while selecting, and to
  none otherwise: turning selection on swaps the lead for the box, so the
  text of a row with a symbol or person moves (intended).
- `href` (+ `onNavigate` to open in place) makes the whole row open its
  entry; `onOpen` only for what has no address.

Rows may also stand directly in a `Section` or `Band`.

A row with an amount, a state and a deed in a narrow column (an invoice in
a 400 px panel): two lines `[customer, "1.280,00 € · fällig 12. Nov."]`,
the number as `meta`, the state chip in `end`, the deed as `action`.

### Table

`columns: Column<T>[]`, `rows: T[]`, `label`. A column: `title`, `cell(row)`
returning one value or `{ lines: [line, quietLine] }`, `align: "end"` for
numbers and amounts, `width={{ min, default }}` (exactly that wide, cut text
never widens it, grip in the head), `wrap` (one text column may take 3
lines), `drop` (leaves on the phone), `sort` (its head is pressed to sort:
`{ href }` to the page sorted so, with `onNavigate` to open it in place, or
`{ onSort }` for a deed). The phone rows have no heads: a sort given by
`href` stays in the address there; offer another order on the phone in the
page itself if it needs one. The last column takes the rest. Chips,
`Progress`, text buttons are fine in cells. `open(row) => { href } | {
onOpen }` makes each row open its entry.

A large table (Grids, a work list) adds, all optional: `rowKey(row)` (needed
for the next three), `select: { selected, onChange, all, row }` (a box
column; pair it with `StatusRow selection`), `current` (the open row's key,
tinted), `sticky` (first column stays while scrolling sideways), `group(row)
=> { key, head: () => JSX, meta?, count? }` (tinted group rows), `sort: { column,
direction }` (the column sorted now: an arrow and darker words in its head,
`aria-sort` on it), `phone(row) => { lines, avatar?, time?
}` (on the phone each row becomes a two-line row instead).

Give every table whose column widths add up to more than a phone (about
350 px after the dropped ones) a `phone(row)`; otherwise its last columns
are cut off at 390 px (the outline reports it). A phone row opens what
`open(row)` names; a row's other deeds live on the page it opens.

`loading` (`true` or `{ rows?, lines? }`): the head stays and placeholder
rows hold the place of the rows. `empty` (`{ icon, text, action? }`): with
no rows and nothing loading, the empty state stands in place of the table.

### Facts

`items: { label, value, hint?, copy?, mono? }[]`: label 12 quiet, value 13, 32 px
per row; the label column is as wide as the longest label of that list
(80–160 px), so two `Facts` lists may start their values at different
edges.
`copy` adds a copy button with that text; `mono` shows a value read sign by
sign (a token, a key, an ID) in monospace, broken at any sign and selected
whole by one click. `inline` puts all on one
line with `end` (such as a print button).

### Text

`type`: `meta` 12/16, `row` 13/20 (default), `body` 14/20, `lead` 18/24.
`weight` (`"strong"` 600, `"medium"` 500 for a state or amount that stands
out a little), `muted`, `tone` (`ok`, `warn`, `bad`, `ai`, `draft`), `href`
(underlined words that lead somewhere; blue is only for the main action).
Without `type`, text takes the role of its place.
In a column it is a block with the text edge; in a bar or row it runs
inline. Emphasis is a weight, never a size.

### Prose

Reading text (14/22, measure 720): `markdown` (rendered safely: no images,
safe links only) or children.

### Inline

One line of things with the one gap of 8 px, such as chips after a count
in a `Bar start`. In a column narrower than 480 px it wraps onto more
lines instead of cutting a thing.

### Icon, Avatar, Chip, Progress

- `Icon`: `name`, `label` (without one it is decoration), `tone`.
- `Avatar`: a `Person`; the place sets the size. With `image` the picture
  lies over the initials: while it loads and when it fails the initials
  show, and nothing moves. Beside the name (`RecordHead`, a `Button`) the
  avatar is decoration and says nothing a second time.
- `Chip`: exactly one kind: `status` (dot + word), `yours` (+ `dot` for
  "in Arbeit"), `tag` (+ `color`), `amount` (`out` or `in`), `ai`, or
  plain; `icon`; `onClick` or `href` makes it a control, `pressed` marks an
  active filter. Never a colour without a word. There is no neutral status:
  "Pausiert" is `warn` or a plain chip.
- `Progress`: `value`, `of`, `label` ("Arbeitstag 5 von 22").

## Controls

- `Button`: `variant` `primary` (one per page), default (framed), `ghost`,
  `text` (quiet, in heads and at row ends); `icon`, `avatar` (a `Person`,
  such as the one a thread is assigned to), `href` (+ `onNavigate`),
  `onClick`, `menu` (chevron), `forward`, `disabled` (dimmed), `busy` (a
  turning sign over the label while its deed runs, such as a save: the
  width, the look and the focus stay, a second press and a second sending
  of the form do nothing), `pressed` (a toggle such as a favourite star:
  `true` is on, its symbol and words in the one colour of pressed, `false`
  is off; not for links or the primary action), `type`, `keep` (stays
  in a head on the phone), `title` (a hint under the pointer, for a button
  whose words give way to its symbol in a narrow place). Without children
  it needs `label`.
- `Field`: `label`, `name`, `hint`, `error` (replaces the hint, marks the
  control), `optional` (one quiet word at the end of the label line: a unit
  such as "Sekunden", or "optional"), one control as child. `Field.Row`
  puts fields side by side (one column on the phone). `required` keeps the
  form from being sent without a value; the label line shows nothing for
  it, the fields that may stay empty say "optional". After a failed save a
  required field shows `error="Pflichtfeld."`.
- `Input`: `value`, `placeholder`, `type`, `icon`, `multiline`, `min`,
  `max`, `onInput`; `label` when it stands without a `Field` (a search).
  `onKeyDown` (Enter to search, Escape to clear; while
  `event.isComposing`, Enter belongs to the input method and must not
  search), `ref` (the text field, to focus it), `end` (a symbol or a ghost
  icon button, such as the filter of a search), `disabled` (a grey well
  that takes no input; the browser leaves it out of a sent form).
- `Select`: `options` (strings or `{ value, label }`), `value`, `onChange`,
  `placeholder`.
- `DateInput`: `value`, `onInput`, `placeholder`.
- `Check`: `label`, `checked` (`true`, `false`, `"mixed"`), `switch`,
  `onChange`, `disabled` (dimmed).
- `Choice`: a few visible options, one chosen: `name`, `options`, `value`,
  `label`, `onChange`, `disabled` (every option dimmed). With a `label` and no `Field` around it, it shows
  that label as a field of its own; inside a `Field` the field's label is
  its question.

## Components

- `Nav`: `title`, `icon`, `groups: { label?, action?, items }[]`, `foot`.
  A group's `action` is one quiet icon button, or `{ label, items }`: a "…"
  with the group's deeds ("Neues Postfach", "Gelöschte Postfächer").
  An item: `label`, `icon`, `href` or `onClick`, `count`, `current`,
  `menu` (its deeds, such as pin and hide: a "…" over its count that shows
  under the pointer and with the focus; Tab always reaches it),
  `nested`, `dot` (`"ok"` for something new, `"warn"`/`"bad"` for a
  problem there). An item with `items` instead of `icon` and a link folds
  them away ("Mehr" with archive, bin and spam): a chevron in the symbol's
  place, its entries one level further in, open while one of them is the
  open one. It remembers nothing; keep what is folded the same on each page.
- `Tabs`: `label`, `items: { label, icon?, count?, href?, onClick?,
  current?, menu? }[]`. In a head `Bar start` they share the bar with actions; as a `Pane`
  head they are their own 44 px bar. `menu` takes the entries of a `Menu`:
  the tab ("Weitere +8") opens the views that have no tab of their own; it
  stands at the end and its `count` counts its own entries. A tab is never
  cut: one without room hides whole and joins that menu (and its count),
  opening from there as it does as a tab; without a menu tab a tab "Mehr"
  holds them. Known: while tabs hide, a gap of less than one tab may stand
  before the menu tab.
- `StatusRow`: `lead` (the one statement, "7 ungelesen"), `facts: { before?,
  value?, after? }[]` (leave on the phone, so put what must stay in `lead`),
  `select: { label, checked?, onChange? }` (select-all box), `filters` (end:
  `ListOrder` with the sort and the grouping of a list query, or a quiet
  `Button variant="ghost" menu`; leave on the phone),
  `selection: { count, actions, clear }` (while rows are selected the row
  becomes the bar of what can be done with them).
- `Path`: `label`, `items: { label, href? }[]`; where a page stands, in the
  head `Bar start` instead of `Tabs`. The last item is the page itself. On
  the phone a head with a path is hidden and the shell's phone bar names
  the page.
- `Steps`: `label`, `items: { label, meta?, state: "done" | "now" | "next"
  }[]`; a way of a few steps, such as a delivery's way inside its `Group`.
- `Notice`: `tone` `note`, `ai`, `bad`, `warn`; `title`, `meta`, `icon`,
  `actions` (≤ 2 text buttons; `disabled` on one that cannot be taken
  now, and the sentence says why), children (the sentence and its
  consequence). Use it for errors with a way out instead of "try again"
  buttons of your own.
- `Digest`: the newest few without lines: `items: { icon, color?, date,
  title, state: { icon, label, tone? }, text, href? }[]`.
- `FilterBar`: the filters of a list as statements, in `Pane status` above
  its `StatusRow`: `query` (from `defineListQuery`), `state`, `onChange`;
  optional `base` (the view's state, where "Zurücksetzen" returns),
  `icons`, `counts`, `names` (per field: lookup names the server resolved),
  `timeZone` (of points in time, "UTC" by default), `views` (`{ stores,
  current?: { key, label, query, scope? }, onSaved?, onRemoved? }`), `results` ("9 Artikel"
  for the phone sheet). It writes the address itself. See
  [list queries](list-queries.md).
- `ListOrder`: `query`, `state`, `onChange`; the sort and the grouping in
  words, for `StatusRow filters`.
- `Lookup`: `label`, `value`, `onChange`, `load`, `resolve?`, `known?`,
  `limit?`, `minChars?`; values that load while the person types, in a
  filter (the bar opens it) or in a form.
- `RecordHead`: `name`, `avatar`, `kinds`, `ids: { label?, value, icon?,
  copy? }[]`. Put it in the head `Bar start`. When the head has no room, the
  ids give way first (always on the phone), then the name is cut with "…";
  the head's actions keep their place.

## Overlays: Menu, Popover, Toast

- `Menu`: `items`, the button's look like `Button` (`label`, `icon`,
  `variant`, `disabled`; children are the words). Without words it is the
  quiet "…" (`dots`) named by `label` ("Weitere Aktionen" by default); in a
  head it stays on the phone. An entry: `label`, `icon`, `onClick` (a
  Promise keeps the menu open and the entry busy), `href`, `danger`,
  `disabled`, `meta` (a quiet hint at the end, such as a key), `checked`
  (an entry that toggles; `onClick` flips it, the tick stands at the end),
  `items` (a submenu to the side); or `"separator"` between groups; or a
  section `{ title, items }` under a quiet heading. A section with
  `choice` and `onChoose` is one choice (reply kind, sender, order): its
  entries are options (`value`, else `label`), the chosen one carries the
  tick, choosing closes the menu. Lines around sections and before the
  first `danger` entry come by themselves. The menu lines up with
  its button; there is no `align`.
- `Menu.Context`: `items`, and one element as child, such as a `Row`. A
  right-click or a long press opens the menu at the pointer, Shift+F10 at
  the element. It adds no wrapper, so a `Row` stays a child of its `List`.
  Give the same entries to a "…" in the row's `end` for those who do not
  right-click.
- `Popover`: a panel behind a button: the button's look like `Menu`,
  `title`, `content` (primitives such as `Check`, `Facts`, `Text`). Escape
  and a press outside close it. With `tip` instead, a short hint on its one
  child (a `Button`) after a moment on hover or focus.
- `useToast()`: call it in the component, then
  `toast("In „Lieferanten“ verschoben", { undo: moveBack, status: "ok" })`.
  One sentence at the bottom in the middle, five seconds, "Rückgängig" with
  `undo`, or "Erneut versuchen" with `retry` for a deed that failed; `status` `ok` or `bad` adds a sign
  (`bad` is announced at once).
  A toast reports a deed; it never replaces `Failed` or a `Notice` at the
  place of a problem.

## Overlays: Menu, Popover, Toast

- `Menu`: `items`, the button's look like `Button` (`label`, `icon`,
  `variant`, `disabled`; children are the words). Without words it is the
  quiet "…" (`dots`) named by `label` ("Weitere Aktionen" by default); in a
  head it stays on the phone. An entry: `label`, `icon`, `onClick` (a
  Promise keeps the menu open and the entry busy), `href`, `danger`,
  `disabled`, `meta` (a quiet hint at the end, such as a key), `checked`
  (an entry that toggles; `onClick` flips it, the tick stands at the end),
  `items` (a submenu to the side); or `"separator"` between groups; or a
  section `{ title, items }` under a quiet heading. A section with
  `choice` and `onChoose` is one choice (reply kind, sender, order): its
  entries are options (`value`, else `label`), the chosen one carries the
  tick, choosing closes the menu. Lines around sections and before the
  first `danger` entry come by themselves. The menu lines up with
  its button; there is no `align`.
- `Menu.Context`: `items`, and one element as child, such as a `Row`. A
  right-click or a long press opens the menu at the pointer, Shift+F10 at
  the element. It adds no wrapper, so a `Row` stays a child of its `List`.
  Give the same entries to a "…" in the row's `end` for those who do not
  right-click.
- `Popover`: a panel behind a button: the button's look like `Menu`,
  `title`, `content` (primitives such as `Check`, `Facts`, `Text`). Escape
  and a press outside close it. With `tip` instead, a short hint on its one
  child (a `Button`) after a moment on hover or focus.
- `useToast()`: call it in the component, then
  `toast("In „Lieferanten“ verschoben", { undo: moveBack, status: "ok" })`.
  One sentence at the bottom in the middle, five seconds, "Rückgängig" with
  `undo`, or "Erneut versuchen" with `retry` for a deed that failed; `status` `ok` or `bad` adds a sign
  (`bad` is announced at once).
  A toast reports a deed; it never replaces `Failed` or a `Notice` at the
  place of a problem.

## States

Each stands where the data will stand, without a box, so the head and the
status row above it never move.

- `Empty`: `icon`, `text` (one sentence that says what is the matter: "Noch
  keine Einlieferung." is not "Keine Treffer mit diesem Filter."), `action`
  (the one way out).
- `Loading`: `rows` (3 when not set; give as many as usually come),
  `lines` (1, 2 or 3, as the rows that will come). It stands where the
  `List` will stand; a `Table` takes `loading` itself.
- `Failed`: `text` (what could not be loaded and what stays as it is),
  `onRetry`; the button says "Erneut versuchen". Only for data that failed
  to load once, in its place. Never in a status row: a connection that
  retries on its own says so in the `StatusRow` without a button, and
  something a person must fix is a `Notice` that names the deed.

## Tools

- `describeV2(element, { layout? })`: the text outline of a screen; see
  `seeing.md`.
- `@k2b/ui/v2/testing`: `measureV2Layout(page)`, `describeV2Page(page)`,
  `settled(page)` for Playwright tests; see `seeing.md`.
- Tokens for tests: `typeRoles`, `fontWeights`, `heights`, `textEdge`,
  `radii`, `hairline`, `gripTolerance`.
