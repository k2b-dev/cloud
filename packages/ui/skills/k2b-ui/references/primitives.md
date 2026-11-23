# Primitives and components of @k2b/ui/v2

Every part marks its root with `data-k2-part="<Name>"`; that name is what
`describeV2` prints. No part takes `class`, `style`, `size`, `gap`,
`padding` or `density`. Shared types: `Action = { label, icon?, href?,
onClick?, meta?, forward? }`, `Width = { min, default }` (px), `Status =
"ok" | "warn" | "bad"`, `Person = { name, initials?, color? }`. Icons are
Tabler names without `ti-` (`plus`, `package`).

## Frame

### Workspace

The working surface of an app: one per screen.

- `sidebar` (usually `Nav`), `sidebarWidth` (default 200–248), `sidebarLabel`
  (name of its grip).
- `head`: a `Bar` across the main column (56 px).
- `primary`: the main `Action`. It floats bottom right on the phone only;
  also put the same action as `Button variant="primary"` in the head end.
- children: a `Pane` or a `Pane.Split`.
- Phone (< 768 px): the sidebar leaves, head actions hide unless `keep`.

### Pane

A column that scrolls, with no padding: everything in it reaches both edges.

- `head` (a `Bar` or `Tabs`), `status` (a `StatusRow`), `label`.
- `width={{ min, default }}`: only inside `Pane.Split`; puts a grip on its
  line.
- `detail`: the reader beside a list. Hidden on the phone; open the entry as
  its own page there.
- `side`: the info column of a record; quieter sections, a `more` link
  becomes a row.
- children: bands, sections, groups, lists, tables, notices, `Text`.

### Pane.Split

Panes side by side (list | reader, main | side). One hairline between, a
grip where a pane has `width`. A `Pane.Split` may stand inside a `Pane`
under that pane's `Tabs` head (see `record.tsx`).

### Bar

A bar of fixed height with one line below: `start`, `end`. Height comes
from the place: 56 as a head, 52 as a status row, 40 inside a pane. Put
`Text`, `Tabs`, `RecordHead`, `Inline`, `Button`s, `Avatar` in it. Text in
a bar is cut to one line.

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
`more` (one link at the end: "All deliveries ›"), children. No line under
the head or between entries, one line at the end. Put `Row`s directly in a
section, or a `Digest`, `Facts`, `Group`s.

### Group

What belongs together, framed: `icon`, `color`, `title`, `count`, `meta`
(head grows to 56), `state` (a `Chip`), `actions`, `folded` (head only),
children. No line inside; never a `Group` in a `Group`. Several groups
stand in one `Section`.

## Content

### List and Row

`List` holds `Row`s (`label` names it). A `Row`:

- `lines`: 1–3 texts. 1 line 40 px, 2 lines 52 px (second quiet), 3 lines
  72 px (mail: sender, subject, preview).
- lead: `icon` + `color`, or `avatar`, or a dot when `unread`.
- `meta` (quiet note after the title, a count), `time` (top right).
- `marks` (chips, icons, avatars bottom right): use them with 3 lines; on a
  2-line row they add a third line.
- `action` (one framed button at the end; under the text on the phone),
  `end` (a few icon buttons).
- states: `unread`, `strong`, `selected` (the open one), `yours` (you are
  next).
- `href` or `onOpen` makes the whole row open something.

Rows may also stand directly in a `Section` or `Band`.

### Table

`columns: Column<T>[]`, `rows: T[]`, `label`. A column: `title`, `cell(row)`
returning one value or `[line, quietLine]`, `align: "end"` for numbers and
amounts, `width={{ min, default }}` (exactly that wide, cut text never
widens it, grip in the head), `wrap` (one text column may take 3 lines),
`drop` (leaves on the phone). The last column takes the rest. Chips,
`Progress`, text buttons are fine in cells.

### Facts

`items: { label, value, hint?, copy? }[]`: label 12 quiet, value 13, 32 px
per row; `copy` adds a copy button with that text. `inline` puts all on one
line with `end` (such as a print button).

### Text

`type`: `meta` 12/16, `row` 13/20 (default), `body` 14/20, `lead` 18/24.
`strong` (600), `muted`, `tone` (`ok`, `warn`, `bad`, `ai`, `draft`).
In a column it is a block with the text edge; in a bar or row it runs
inline. Emphasis is a weight, never a size.

### Prose

Reading text (14/22, measure 720): `html` (sanitised by you) or children.

### Inline

One line of things with the one gap of 8 px, such as chips after a count
in a `Bar start`.

### Icon, Avatar, Chip, Progress

- `Icon`: `name`, `label` (without one it is decoration), `tone`.
- `Avatar`: a `Person`; the place sets the size.
- `Chip`: exactly one kind: `status` (dot + word), `yours`, `tag` (+
  `color`), `amount` (`out` or `in`), `ai`, or plain; `icon`; `onClick` or
  `href` makes it a control. Never a colour without a word.
- `Progress`: `value`, `of`, `label` ("Arbeitstag 5 von 22").

## Controls

- `Button`: `variant` `primary` (one per page), default (framed), `ghost`,
  `text` (quiet, in heads and at row ends); `icon`, `avatar`, `href`,
  `onClick`, `menu` (chevron), `forward`, `disabled`, `type`, `keep` (stays
  in a head on the phone). Without children it needs `label`.
- `Field`: `label`, `name`, `hint`, `error` (replaces the hint, marks the
  control), `optional` (quiet word such as "Sekunden"), one control as
  child. `Field.Row` puts fields side by side (one column on the phone).
- `Input`: `value`, `placeholder`, `type`, `icon`, `multiline`, `min`,
  `max`, `onInput`; `label` when it stands without a `Field` (a search).
- `Select`: `options` (strings or `{ value, label }`), `value`,
  `placeholder`.
- `DateInput`: `value`, `placeholder`.
- `Check`: `label`, `checked` (`true`, `false`, `"mixed"`), `switch`,
  `onChange`.
- `Choice`: a few visible options, one chosen: `name`, `options`, `value`,
  `label`, `onChange`.

## Components

- `Nav`: `title`, `icon`, `groups: { label?, action?, items }[]`, `foot`.
  An item: `label`, `icon`, `href` or `onClick`, `count`, `current`,
  `nested`, `dot`.
- `Tabs`: `label`, `items: { label, icon?, count?, href?, current?, menu?
  }[]`. In a head `Bar start` they share the bar with actions; as a `Pane`
  head they are their own 44 px bar.
- `StatusRow`: `lead` (the one statement, "7 ungelesen"), `facts: { before?,
  value, after? }[]` (leave on the phone), `select` (select-all box),
  `filters` (end: a `Button variant="ghost" menu`, chips).
- `Notice`: `tone` `note`, `ai`, `bad`, `warn`; `title`, `meta`, `icon`,
  `actions` (≤ 2 text buttons), children (the sentence and its
  consequence). Use it for errors with a way out instead of "try again"
  buttons of your own.
- `Digest`: the newest few without lines: `items: { icon, color?, date,
  title, state: { icon, label, tone? }, text, href? }[]`.
- `RecordHead`: `name`, `avatar`, `kinds`, `ids: { label?, value, icon?,
  copy? }[]`. Put it in the head `Bar start`.

## Tools

- `describeV2(element, { layout? })`: the text outline of a screen; see
  `seeing.md`.
- Tokens for tests: `typeRoles`, `fontWeights`, `heights`, `textEdge`,
  `radii`, `hairline`, `gripTolerance`.
