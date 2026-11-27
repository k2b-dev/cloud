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
  A search in the head (`Input type="search"`) stays as its symbol; a tap
  goes into the field, which opens over the head while it has the focus
  and folds back, its words kept, on blur or Escape. A host that offers the
  page's search in a bar of its own (the Cloud shell's phone bar) marks the
  v2 scope with `data-k2-host-search`: the folded search then leaves the head
  to its tabs and the Tab key's order on the phone, and the host focuses the
  field from its bar (a head with a path opens it over the first row).

### Pane

A column that scrolls, with no padding: everything in it reaches both edges.

- `head` (a `Bar` or `Tabs`), `status` (what stays under the head while
  the column scrolls: a `StatusRow` of 52 px above a list, or a `Bar` of 40 px
  with the state of an open entry above a reader), `label`.
- `width={{ min, default }}`: only inside `Pane.Split`; puts a grip on its
  line. A drag or the keys (arrows 8 px, Shift 64 px, Home and End to the
  limits, Enter back to the default) move the width; a reload starts at the
  default again. The sidebar's grip works the same.
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
- `center`: the content stands in the middle of the column, across at its
  own measure (at most four cards of 240 px with their gaps) and in the
  middle of the height where it fits; taller content starts at the top and
  scrolls, and on the phone it always starts at the top. Only for a page
  with little on it and nothing beside it, such as the first start of an
  app without data: one `Text type="lead"` line and `Tiles perRow={4}` with
  the ways to start, without a sidebar. The line stands centred over the
  cards, on the phone at the start. No line or box of its own; CSS
  alone, so the server's first render already stands there.
- children: bands, sections, groups, lists, tables, notices, `Text`.

### Pane.Split

Panes side by side (list | reader, main | side). One hairline between, a
grip where a pane has `width`. A `Pane.Split` may stand inside a `Pane`
under that pane's `Tabs` head, after content that spans both columns (see
`record.tsx`).

A short task above the page is a `Dialog` (see "Overlays"), not one more
pane; `Workspace primary` never confirms a dialog.

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
`href` (adds a chevron), `trend` (a `Spark` at the end of the value, such
as orders per day this week), `loading` (a bar lies on value and `meta`;
what is there keeps its room unseen under it, a value not there yet is one
line; symbol and label stay, a `trend` keeps its place unseen). Use for the
key statements of a record or the home of a place.

### Tiles

Like things to press, such as attachments: `items: { icon, title, meta?,
href?, onNavigate?, color? }[]`, `more` (an action after them), `label`.

`variant="media"`: photos, pages and videos in a grid of at least 160 px.
A tile adds `image` (its picture, 4:3), `kind` (`PDF`, a video's length),
`people` (the first is the owner, 16 px), `sign` (`{ icon, label }` at the
end of its quiet line, such as the sharing state) and `key`. `select: {
selected, onChange(key, on) }` puts a box on each picture; it shows under
the pointer, with the focus, on touch, and on all tiles while one is
selected; a selected tile is blue with a line inside its edge.
Never nested. With `color` the symbol becomes the thing's `Mark`.
`perRow={n}`: at most n tiles share a row and grow with its width; a tile
never gets narrower than 240 px for it. Where n do not fit, a row holds
half of them (four as 2 × 2, never 3 + 1), and below that one under the
other. On the phone a row always holds half of them, even below 240 px.

`variant="card"`: each thing a card in a grid (at least 240 px a card) for
an overview of things with a face, such as the bases of Grids. A card
adds `stats` (`{ icon?, label, status?, yours? }`: "6 Tabellen", "8 knapp"
in `warn`), `people` (an `Avatar.Stack` at the foot), `foot` (quiet words
at its end: "Felix · vor 2 Min") and `trend` (a `Spark` at the top end, in
the card's colour), `preview` (a glance of what it holds across its top,
112 px, 84 px on the phone: `{ table: { columns, rows } }` as a small
table of words (a column `{ label, align: "end" }` for amounts), two columns on the phone, `{ page: { title, text? } }`, or
`{ icon }` for a thing that holds nothing yet; it is a picture, the card
keeps its name). The whole card opens its `href`. `create` adds the last
card that makes a new thing: dashed, `title`, `meta`, `href` or `onClick`,
and `choices` as round chips (templates). Cards hold no box and no line.
Among media, `create` is the last tile too: a dashed picture with a plus,
then its `title` and `meta` ("Neuer Ordner", "oder Dateien hierher
ziehen").

### Canvas

The only place for own drawing and own CSS (a map, a chart). `label`
(required), `height` in px. It must stand directly in a primitive
(`<Band><Canvas …/></Band>` or directly in a `Pane`), never as a
component's root and never in a plain element. A `Chart` of `@k2b/ui`
fills it (`style={{ height: "100%" }}`) with `v2.css` alone. While the
drawing loads, fails or has no data, put `Loading`, `Failed` or `Empty`
inside the `Canvas`: with a `height` it keeps that height, so nothing
moves. `height="fill"`: the drawing is the whole pane (an editor, a frame
of another page). Directly in its `Pane`, it takes the height left under
head and status by layout alone, from the first render (never measure it
in a script); below 240 px the pane scrolls. In a `Pane.Split` on the
phone, where the panes stand one under the other, its pane takes the
height that is left, so the drawing still fills it.

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
`menu` (more deeds behind "…"), `folded` (starts as head only; its
chevron opens and closes it in place), children. No line inside; never a `Group` in a `Group`, and never in a
`Band` (the band's line would cut the frame). Groups stand in a `Section`
or directly in a `Pane`. A group's way (arrived → … → paid) is `Steps`
inside it.

## Content

### List and Row

`List` holds `Row`s (`label` names it). A `Row`:

- `lines`: 1–3 texts. 1 line 40 px, 2 lines 52 px (second quiet), 3 lines
  72 px (mail: sender, subject, preview).
- lead: `mark` (the thing's `Mark`: a base, a file with its thumbnail, a
  table; 32 px, and a row of one line with it is 44 px), or `avatar`, or a
  quiet `icon` for a plain place or deed, or a dot when `unread`.
- `meta` (quiet note after the title, a count), `time` (top right). Title
  and `meta` share the first line in equal parts, and each takes only what
  it needs: a count or a number stays whole, a long note is cut with "…",
  and the title breaks only when it is longer than its part.
- `marks` (chips, icons, avatars bottom right): use them with 3 lines; on a
  2-line row they add a third line. The third line shares its width with
  the marks, so keep it a preview text that may be cut, never an amount.
- `states` (chips that must be read whole, such as the checks of a domain:
  colour, symbol, word): under the lines on the title's text edge; they
  wrap to more lines instead of being cut, on the phone too, and the row
  grows only when they are there.
- `action` (one framed button at the end; under the text on the phone; its
  name is its words and then the row's title, "Ansehen Angebot Küche", so
  rows with the same deed are told apart: name nothing yourself; on the
  phone a finger hits 44 px of it, its look unchanged),
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
never widens it, a grip in the head that a drag or the keys move), `wrap` (one text column may take 3
lines), `drop` (leaves on the phone), `sort` (its head is pressed to sort:
`{ href }` to the page sorted so, with `onNavigate` to open it in place, or
`{ onSort }` for a deed). The phone rows have no heads: a sort given by
`href` stays in the address there; offer another order on the phone in the
page itself if it needs one. The last column takes the rest. Chips,
`Progress`, text buttons are fine in cells. `open(row) => { href } | {
onOpen }` makes each row open its entry. A column's `mark(row)` leads its
cell with the thing's `Mark` (a file's thumbnail or type, 32 px; the
table's rows are then 44 px, as the mockup's lists), its
`avatar(row)` with a person (the name in the cell names it); `phone(row)`
takes a `mark` as well.

A large table (Grids, a work list) adds, all optional: `rowKey(row)` (needed
for the next three), `select: { selected, onChange, all, row }` (a box
column; pair it with `StatusRow selection`), `current` (the open row's key,
tinted), `sticky` (first column stays while scrolling sideways), `group(row)
=> { key, head: () => JSX, meta?, count? }` (tinted group rows), `sort: { column,
direction }` (the column sorted now: an arrow and darker words in its head,
`aria-sort` on it), `phone(row) => { lines, avatar?, time?, marks?
}` (on the phone each row becomes a two-line row instead: `time` top right,
`marks` at the end of the second line, such as the entry's state chip).

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
line with `end` (such as a print button). `loading` while the values are on
their way: labels, hints and copy buttons (not yet usable) stay, and a
quiet bar lies on each value. A value that is there (a refresh) keeps its
exact room unseen under the bar (lines, chips, wrapping); a value not there
yet (`""`) is a bar of one line. Give `copy: ""` where a value will have
one.

### Text

`type`: `meta` 12/16, `row` 13/20 (default), `body` 14/20, `lead` 18/24.
`weight` (`"strong"` 600, `"medium"` 500 for a state or amount that stands
out a little), `muted`, `tone` (`ok`, `warn`, `bad`, `ai`, `draft`), `href`
(underlined words that lead somewhere; blue is only for the main action).
Without `type`, text takes the role of its place.
`title` gives text its full words as a tooltip where its place may cut it:
the title of an open entry in its detail's head takes two lines, then "…".
Two lines make that head 65 px: beside a list, its line then no longer meets
the status row (K1 holds for a one-line title).
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
- `Mark`: what a thing looks like. `icon` + `color` (its data colour, or
  the colour of its kind: table, form, PDF), `image` (a thumbnail over the
  symbol; while it loads and when it fails the symbol shows), `kind` (the
  type on its corner: `PDF`), `label` (without one it is decoration beside
  its name). The place sets the size: 20 in the sidebar and in a sentence,
  24 leading a row of one line, 32 leading a row of two or three, 36 on a
  card. In a sentence write `<Mark {...table} /><Text weight="strong">Aufträge</Text>`.
- `Avatar.Stack`: `people`, `max` (3, at most 5), `label`. People over each
  other with a ring and "+n"; one picture with every name. In a narrow
  place (a 90 px column) it shows the faces it holds whole and counts the
  rest; the count is always right and never cut, from the first render.
- `Spark`: `values` (oldest first), `label`: what the bars say as one
  sentence ("Werkstatt: in 7 Tagen von 12 auf 41 Änderungen gestiegen"),
  never only the title of the data. A few bars of a short history, the
  last strongest; beside a number, never instead of it.
- Data colours (`color` of `Mark`, `Avatar`, `Chip tag`, `Nav`, `Tiles`,
  `Section`, `Cells.Cell`, `Digest`, `Preview`) are validated: a hex colour, an
  `oklch()` or `var(--…)`; anything else renders neutral. For a hex colour
  the primitives derive readable foregrounds themselves (symbols and bars
  3:1, type 4.5:1, light and dark), so a pale yellow works too.
- `Preview`: `label`, `icon`, `color`, `image`, `kind`. The large picture of
  the open thing at the top of its detail, 4:3 from text edge to text edge;
  the symbol stands while it loads, fails or is missing.

## Controls

- `Button`: `variant` `primary` (one per page), default (framed), `ghost`,
  `text` (quiet, in heads and at row ends); `icon`, `avatar` (a `Person`,
  such as the one a thread is assigned to), `href` (+ `onNavigate`),
  `onClick`, `menu` (chevron), `forward`, `about` (the id of what the deed
  is about, such as a row's title: its name is its own words, then those;
  `Row` does this for its `action`), `disabled` (dimmed), `busy` (a
  turning sign over the label while its deed runs, such as a save: the
  width, the look and the focus stay, a second press and a second sending
  of the form do nothing), `pressed` (a toggle such as a favourite star:
  `true` is on, its symbol and words in the one colour of pressed, `false`
  is off; not for links or the primary action), `type`, `keep` (stays
  in a head on the phone), `title` (a hint under the pointer, for a button
  whose words give way to its symbol in a narrow place). Without children
  it needs `label`.
- `Setting`: `label`, `name`, `hint`, `error`, `was` ("12 Std.": an unsaved
  change says "geändert · vorher 12 Std." under its control), `action`
  (one quiet deed at the end of the name's line, such as "Auf Standard
  zurücksetzen" while the value differs from its default, as `Field
  action`), one control as child. One setting of a settings page: the name
  (13, 500) and its hint on the left, the control in a column of 300 px
  beside them, no line between settings; one column when its pane is
  narrower than 600 px (by the pane, not the window). Never stack `Field`s
  as a settings page.
- `Field`: `label`, `name`, `hint`, `error` (replaces the hint, marks the
  control), `optional` (one quiet word at the end of the label line: a unit
  such as "Sekunden", or "optional"), `action` (one quiet deed at the end
  of the label line instead, such as "Auf Standard zurücksetzen"; the field
  keeps its height), one control as child. `Field.Row`
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
  A search the server answers takes `name` and `send={{ action, params,
  onSearch }}`: the field is its own GET form, so Enter loads `action`
  with the text and `params` (the rest of the address) also without
  JavaScript; `onSearch` searches in place where JavaScript runs. It keeps
  its place in a head and folds on the phone, and its form is named by
  `label`. Never wrap it in a `<form>` and never put it inside one: forms
  do not nest, and the browser drops the inner one (`describeV2` reports
  both).
  The standard text-field attributes pass through and stand in the
  server's markup, so a password manager reads them before the island
  hydrates: `autocomplete` (`username`, `current-password`,
  `new-password`, `one-time-code`, `off`), `maxLength`, `inputMode` (the
  phone keyboard, such as `numeric` for a code), `spellcheck` and
  `autocapitalize` (`false` and `off` for names, codes and keys). Never set
  them through `ref` after hydration.
- `Select`: `options` (strings or `{ value, label, disabled }`), `value`,
  `onChange`, `placeholder`, `disabled` (a grey well, the value still
  shown, while it cannot be changed).
- `TagsInput`: several short values as chips in one field (domains,
  server addresses): `value`, `onChange`, `suggestions` (values to pick
  while typing; any other text is taken on Enter), `placeholder`,
  `disabled`. Backspace in the empty field takes the last chip back.
- `ImageInput`: one image: `value` (its address), `onChange` (the new
  address, or `null` when removed), `transform` (file to address; by
  default a square picture as a data URL; upload and return a URL for
  large files), `accept`, `round` (a person's picture), `disabled`. A
  dropped or pasted file counts as chosen.
- `Slider`: a number on a range: `value`, `onChange` (every step),
  `onCommit` (the drag or key press ended: save here), `min`, `max`,
  `step`, `format` (`Intl.NumberFormat` options, such as percent),
  `disabled`. The number reads at the end.
- `ColorInput`: a colour as `#rrggbb`: `value`, `onChange`, `onCommit`,
  `swatches` (presets), `disabled`. Swatch and code (any CSS colour typed
  in), a surface of saturation and brightness, a hue slider, the presets.
- `CodeInput`: a one-time or pairing code, a box per character: `value`,
  `onInput`, `onComplete` (the last box filled), `length` (6),
  `characters` (`digits` or `alphanumeric`), `autocomplete`
  (`one-time-code` by default; `off` for a code shown on another device),
  `disabled`.
- `DateInput`: `value` (a date key such as "2026-12-15", or as the locale
  writes it), `onInput` (a date key, "" when emptied), `placeholder`. Typed
  text ("24.11.2026", "heute", "+3") applies on Enter or leaving the field;
  the calendar symbol opens `DatePicker` below the field. A form gets the
  date key under `name`; text that is no date (also "2026-02-30") marks the
  field and makes the form invalid. `timeZone` says which day "heute" is
  ("UTC" by default); give the same zone on the server and in the island.
- `DatePicker`: one month of days to pick from (a calendar grid: arrows,
  PageUp/PageDown, Home/End, Enter; the locale's month names and first day of
  the week; six weeks, so its height never changes). `value`, `onPick`,
  `min`, `max`, `timeZone` (which day is today), `label`, `error`,
  `onClear` ("Leeren"), `autoFocus`; `time` adds the ui-sdk time input: hour
  and minute as spinbuttons in the locale's clock (24 hours in German, AM/PM
  in American English; typing, arrows, Backspace; never the browser's time
  field), applied
  with "Übernehmen". `view="weeks"` (with a required `min`, usually today) shows six
  weeks from the week of `min` as one grid instead of whole months, for a moment ahead ("Später", an
  expiry): one row per week over the ends of months, the 1st shows the
  month's short name, keys move the weeks, the arrows by six. Use it inside a
  popover or sheet; a form field is `DateInput`.
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
  problem there), `color` (the place's data colour: its symbol becomes its
  `Mark`, the same as in its rows and on its card). `quota: { label, value,
  of, text }` shows what the open place uses above the foot ("Werkstatt ·
  38,2 von 100 GB" over a bar; amber from 75 %, red from 90 %). An item with `items` instead of `icon` and a link folds
  them away ("Mehr" with archive, bin and spam): a chevron in the symbol's
  place, its entries one level further in, open while one of them is the
  open one. It remembers nothing; keep what is folded the same on each page.
- Counts of `Nav` and `Tabs`: a number is written in the page's language and
  in full (12.345 in German, 12,345 in English), never cut to "9.999+"; words
  you give (`"99+"`, `"+8"`) stay as they are.
- `Tabs`: `label`, `items: { label, icon?, count?, href?, onClick?,
  current?, menu? }[]`. In a head `Bar start` they share the bar with actions; as a `Pane`
  head they are their own 44 px bar. `menu` takes the entries of a `Menu`:
  the tab ("Weitere +8") opens the views that have no tab of their own; it
  stands at the end and its `count` counts its own entries. A tab is never
  cut: one without room hides whole and joins that menu (and its count),
  opening from there as it does as a tab; without a menu tab a tab "Mehr"
  holds them. Known: while tabs hide, a gap of less than one tab may stand
  before the menu tab.
- `StatusRow`: `lead` (the one statement, "7 ungelesen"; cut with "…"
  where it does not fit before the filters), `loading` (results
  refresh in place: `true` turns a quiet mark after the lead; pass `false`
  while idle so its 16 px stay reserved and nothing moves; leave it out where
  the row never refreshes), `facts: { before?, value?, after? }[]` (where
  they do not fit before the filters, the later ones give way whole, so the
  filters keep their words; they go on the phone; put what must stay in
  `lead`),
  `select: { label, checked?, onChange? }` (select-all box), `filters` (end:
  `ListOrder` with the sort and the grouping of a list query, or a quiet
  `Button variant="ghost" menu`, each with an `icon`; below 600 px of row
  they keep only their symbols, the words stay their names; leave on the
  phone),
  `selection: { count, actions, clear }` (while rows are selected the row
  becomes the bar of what can be done with them; the count stands in 14 px
  600; from five deeds on the first three stand and the rest wait in
  "Mehr", so give the deeds in their order of use).
- `Path`: `label`, `items: { label, href? }[]`; where a page stands, in the
  head `Bar start` instead of `Tabs`. The last item is the page itself. On
  the phone the path gives way and the shell's phone bar names the page; the
  head itself is hidden unless it holds a search, which stays as its symbol.
  From five places on, the first place and the page stand and every place
  between folds into a menu "…" in its order, the same on the server and in
  the browser. The page keeps its whole name: where room runs out the places
  between shorten with "…" first, then the first place, the page only when
  nothing else is left; whole names show on hover. The deeds at the end keep
  their words before the path does. In an `Inline` with a chip (a folder's
  sharing) the path behaves the same, and on the phone it gives way there
  too while the chip stays.
- `Steps`: `label`, `items: { label, meta?, state: "done" | "now" | "next"
  }[]`; a way of a few steps, such as a delivery's way inside its `Group`.
- `Notice`: `tone` `note`, `ai`, `bad`, `warn`; `title`, `meta`, `icon`,
  `actions` (≤ 2 text buttons; `disabled` on one that cannot be taken
  now, and the sentence says why), `primary` (the one thing to do, such as
  "Neu laden": a framed button after one quiet text button at most; it is
  no primary of the page), children (the sentence and its
  consequence). Use it for errors with a way out instead of "try again"
  buttons of your own.
- `Digest`: the newest few without lines: `items: { icon, color?, date,
  title, state: { icon, label, tone? }, text, href? }[]`, or `activity`:
  who did what, `{ person, text, time, place?, href?, onNavigate? }[]`
  (`onNavigate` opens the thing in place, as on rows). The sentence
  names the person in `<Text weight="strong">` and the thing with its
  `Mark` and name; place and time stand quiet under it. A form or a
  workflow that did something is a person with its name ("Webformular").
- `FilterBar`: the filters of a list as statements, in `Pane status` above
  its `StatusRow`: `query` (from `defineListQuery`), `state`, `onChange`;
  optional `base` (the view's state, where "Zurücksetzen" returns),
  `icons`, `counts`, `names` (per field: lookup names the server resolved),
  `timeZone` (of points in time, "UTC" by default), `views` (`{ stores,
  current?: { key, label, query, scope? }, onSaved?, onRemoved? }`), `results` ("9 Artikel"
  for the phone sheet). It writes the address itself. See
  [list queries](list-queries.md). `end` (the `ListOrder` and a choice of
  display such as list or grid) makes the bar the one status row of its
  list (52 px) with `results` in quiet words before it: the page head then
  has two rows, path and deeds, then this bar. `display` (`MenuSection`s,
  such as "Darstellung" with list and grid, or a colour choice) puts each
  section as a menu of its own in the end on the desktop; on the phone,
  where the end has no room, sort, grouping and these sections fold into
  one menu "Ansicht" at the end of the bar. Give every choice that changes
  how the list shows to `display`, never to `end` alone, so the phone keeps
  it. While entries are selected a
  `StatusRow selection` takes its place at the same height; on the phone the
  selection's actions float at the bottom, symbol over word.
- `ListOrder`: `query`, `state`, `onChange`; the sort and the grouping in
  words, for `StatusRow filters`.
- `Lookup`: `label`, `value`, `onChange`, `load`, `resolve?`, `known?`,
  `limit?`, `minChars?`; values that load while the person types, in a
  filter (the bar opens it) or in a form.
- `RecordHead`: `name`, `avatar`, `kinds`, `ids: { label?, value, icon?,
  copy? }[]`. Put it in the head `Bar start`. When the head has no room, the
  ids give way first (always on the phone), then the name is cut with "…";
  the head's actions keep their place.

## Overlays: Dialog, Menu, Popover, Toast

- `Dialog`: `title`, `open` and `onOpenChange` (the screen keeps the open
  state), `foot` (the buttons, the main one last: the dialog's own one
  primary), children (fields, a notice, text; they scroll). 480 px in the
  middle; below 768 px a sheet from the bottom that a swipe down closes.
  The first field takes the focus (on the sheet the first control that is
  no text field), else the first action of the foot; focus stays inside,
  Escape and the close button close it, focus returns to what opened it.
  `dismissible={false}`: a press outside, a swipe and the back gesture do
  not close it; Escape, the close button and the foot still do.
- `Dialog.confirm({ title, confirm, description?, cancel? })`: resolves
  `true` when the person agrees. An alert dialog without a close button,
  never a sheet; focus starts on the other button, Escape answers no, a
  press outside does nothing. Call it from a menu entry with `void`, so the
  menu closes while it asks.

- `Menu`: `items`, the button's look like `Button` (`label`, `icon`,
  `variant`, `disabled`; children are the words). Without words it is the
  quiet "…" (`dots`) named by `label` ("Weitere Aktionen" by default); in a
  head it stays on the phone. An entry: `label`, `icon`, `onClick` (a
  Promise keeps the menu open and the entry busy), `href`, `danger`,
  `disabled`, `color` (the data colour of what it stands for, such as an
  area of a notebook: a dot in the symbol's place, or the symbol in that
  colour; a hex colour is kept at 3:1, `oklch()` and `var()` stand as
  given, anything else leaves the entry neutral), `meta` (a quiet hint at the end, such as a key), `checked`
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
  and a press outside close it. Like the menu's "…", a button without words
  stays in a head on the phone; there the panel is a sheet from the bottom,
  which a swipe down also closes. With `tip` instead, a short hint on its one
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
  (the way out), `secondary` (a second, quieter way out after it, as a
  text button, such as "Filter zurücksetzen" and "Ganzes Notizbuch
  zeigen"; the first stays the one a focus that comes to the state reaches).
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
