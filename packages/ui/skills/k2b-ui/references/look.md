# The look

Every v2 screen follows this page. A screen that is clean but bare is not
done: grey text between lines, one weight for everything, no colour of its
app, nothing that shows the shape of its data. People reject such screens
as "wireframes". This page says what a screen must have instead, with
exact values, and how to check your own screen before you call it ready.

The rules R1–R13 below are the reference look of v2: quiet lines, one
clear hero, the app's colour where it means something. The primitives draw
most of it; your job is to choose the right primitive, feed it real data
and leave nothing out. A value marked "drawn by the primitive" is never
set by a screen. Where your version of `@k2b/ui` does not draw a rule yet,
write a `k2b-ui gap` at that place (see "When a part is missing"); never
fake it with app CSS.

## Before you write code

### 1. Write the screen brief

Write it into the pull request (and into the recipe, if you make one)
before the first line of code. Without a brief there is no screen.

```text
Screen:      <app> · <screen>
For:         <who> uses it to <job>, <how often>
Top three:   1. <the one thing that matters today>
             2. <second>
             3. <third>
Secondary:   <what can wait, fold or move to the detail>
Hero:        <the one figure or statement under the head> + <its real trend>
Eye path:    hero → <second> → <third>
390 px:      <what the phone shows, in order>
1024 px:     <what gives way: drawer, dropped columns, context below>
1440 px:     <the default layout>
1920 px:     <what the large screen adds: a context column, a two-column
             detail; never a wider list>
Identity:    owner colour <where>; data picture per row <which>
```

### 2. Start from a recipe or from the rules, not from parts

Where a recipe fits your screen (see [recipes](recipes.md)), copy it, keep
its composition and replace the data. Where none fits, build to R1–R13. A
screen assembled from single parts reads as a random first draft even
when every part is right.

### 3. Feed it the worst case

Before ready, render the screen with worst-case data and look at it at
390, 1024, 1440 and 1920 px:

- names of 60 characters and of one letter; an address with no space;
- right-to-left text, Chinese, an emoji with a joiner;
- amounts of ten digits and below zero; a count of 0 and of 12,345;
- a missing field (no picture, no date, a deleted person);
- an empty list, one row, and a list of 2,000 rows;
- every state the screen has: loading, failed, empty, filtered to nothing.

Nothing may be cut without "…", overlap, move when data arrives or leave
half the screen empty.

### 4. Fail your own screen

It is a wireframe, and not done, if any of these is true:

- it shows only grey text and lines, and the app's colour is nowhere;
- there is no hero, or there are two;
- every row has the same weight, and no column shows data over time where
  the data exists;
- a list row is two lines on the desktop or one line on the phone;
- the open object has a plain white head without its sign and key facts;
- half the screen is empty while there is content to show;
- a count is the biggest text on the screen, or a heading;
- every row carries a chip, or OK states are coloured;
- an action is bare text, or an icon without a word other than ⋯ and ×;
- the title repeats the open entry of the sidebar, or a fact appears twice;
- a 1920 px window shows the 1440 px layout stretched.

Check the list against the picture at each of the four widths, and name in
your report which rule (R1–R13) each fix answers.

## The rules

### R1. Measure, not canvas

- Text starts at the text edge (`--k2-edge`: 20 px, 16 px on the phone),
  drawn by the primitive.
- Settings and detail sections stand at most 1040 px wide from that edge
  (section head B: 232 px head column + 48 px gap + at most 760 px
  content).
- Lists, tables and sections with a large table, `Tiles`, `Group`s or a
  `Canvas` use the full width.
- An action stands at the end of the content it acts on, never at the
  window edge.
- From about 1680 px a list keeps its ideal width (about 640 px) and the
  open detail grows into two columns under its one head: left what it is
  (its chart, access, technical facts), right who and what happened
  (people, alarms, history). Build it as a `Pane.Split` of a `Pane` and a
  `Pane side` inside the detail. A table without a detail gets a context
  column (`Pane side`) on a large screen. Never a wider list, never an
  empty half.
- On the phone an open object is the page, with its way back.

### R2. A head says what it is

Settings and details open with the tinted object head:

- ground in the app tint (`--k2-app-tint`, drawn by the primitive); 14 px above, 16 px below, the text edge on
  the left, 12 px on the right;
- its mark 40 px (radius 10 px), the name 18/600 on one line, one meta
  line 12 px under it;
- up to 3 facts on the right, label over value: label 12 px meta, value
  13/500, 28 px between the facts;
- a problem stands right there in red: its icon, one line in weight 500
  and a 12 px reason under it ("Liefert seit 10:40 keine Werte ·
  Zeitüberschreitung nach 15 s");
- its deeds at the right of the name: one small button, a quiet ⋯, the
  close ×;
- tabs at its lower edge, one line under it.

The top left of a pane is never empty. On the phone the head keeps its
tint, and its facts wrap with 20 px between them.

### R3. Five type steps, hard contrast

| Step | Value | For |
| --- | --- | --- |
| meta | 400 12/16 | labels, counts, times, captions |
| row | 400 13/20 | rows, text, controls |
| title | 600 15/22 | section titles |
| lead | 600 18/24 | the open object's name, a phone title |
| figure | 600 30/34 | the hero figure, once per screen |

- Weights 400, 500 and 600 only. No size outside these steps. The one
  exception is long reading text (`Prose`, a mail body): 400 14/20, drawn
  by the primitive.
- Neighbouring steps in one block also differ in weight or colour: a name
  13/500 beside its meta 12/400 in n500; a fact value 13/500 under its
  label 12/400.
- A count is meta (12 px), and 13/400 in n500 only right after a section
  title (R4). It is never a heading and never the biggest text on the screen.
- Numbers use tabular figures.

### R4. Section head A or B

- No icon. The title 15/600 on one line, never wrapped, its count after it
  (R3); a description 13 px in n600, at most 2 lines. The same in A and B.
- B, by default in a pane of 960 px and more: a 232 px head column with
  the title and description, the section's buttons under the description,
  the content 48 px beside it (R1).
- A, below 960 px and for full-width sections (R1): the button right of
  the title, the content under the head; on the phone two buttons stand
  under the description.
- Facts in a section (`Facts`) are a key-value grid, drawn by the
  primitive: the label 13 px in n500 in a 116 px column, 16 px to its
  value in ink, each pair 34 px high, space and no line between pairs.
  Dense in a side column (`Pane side`): the label 12 px in a 96 px
  column, 12 px to the value, pairs 28 px. On the phone the label (12 px)
  stands over its value (13 px).

### R5. Actions are buttons

- Section and row actions are buttons, drawn by the primitive: a section's
  button 30 px high, 13/500, a 15 px icon in n600 + a verb, its words
  kept on the phone; a button in a row 28 px. Both have a 1 px border in
  the control line (`--k2-line-control`) and radius 8 px.
- Never a bare text link, never an icon without a word except ⋯ and ×.
- Exactly one filled main action per screen. On the phone it floats at the
  bottom right (48 px high), and the end of every scrolling column keeps
  72 px free, so the last row stands above it.

### R6. Row anatomy

- A row: mark 28 · name 13/500 · meta 12 px n500 in the same line (on the
  phone: a second line) · one data column (R9) · a control or state · ⋯.
- Desktop: one line, 46 px (a table cell 44 px). Phone: a row with meta
  becomes two lines, at least 52 px; a table becomes such rows. Descriptions belong in the detail, not in the row.
- What a person can change is a control in the row. In settings, a
  setting is a row: its label and a one-line hint on the left, its value
  at a fixed width on the right (`Setting`). Never full-width fields
  stacked one under the other.
- Heights around rows: the head 56 px (44 px on the phone, with the
  page's views and one search place), a toolbar under it 44 px, a table's
  column head 34 px on n50.

### R7. Every thing has its mark

- People: an avatar with a stable hue from their ID.
- Groups: a tinted mark + a member stack (3 avatars + "+n").
- Objects: a type mark of 20, 28 or 40 px in the type colour on a light
  tone.
- Never a grey square with a grey icon.

### R8. Lines in two weights

All lines are 1 px and drawn by the primitive; never add your own.

- The quiet line (`--k2-hairline-subtle`) separates rows of a list, a
  table or a section. The columns of a table are parted by a still quieter
  inset line (`--k2-line-column`).
- The clear line (`--k2-hairline`) separates sections, a head block from
  its content, a table head from its rows, a list from its detail.
- The last row or section of a pane draws no visible line; never two
  lines at one edge.

### R9. One data figure per list

- Exactly one column shows the shape of the data, where the data exists:
  bars, ticks, a stack of people or a spark. Never two pictures in one
  row, never a picture as decoration. Real data only.
- Its colour is the app's soft tone, drawn by the primitive; amber for
  "too little", red only for errors.
- Ticks: bars 3 px wide, 12 px high, 1 px apart; a failure 16 px high in
  red, no data 4 px high in n200. Spark: the last value in the full app
  colour. People: `Avatar.Stack` of 20 px avatars overlapping by 5 px,
  "+n" as meta.
- The screen's hero is its one big figure: right under the head the
  figure (30/34, letter spacing −0.015em, in the app's ink), what it
  counts (13/500) and one meta line; beside it its trend, 56 px high, as
  bars (3 px gap) or an area, today in the full app colour, earlier days
  in the soft tone; below, after a quiet line, the real exceptions, each
  as "● number word · who". On the phone figure, trend and exceptions
  stand one under the other. Pick the figure a person acts on, not the
  size of the table.

### R10. Surfaces and colour only with meaning

- The page ground is in the app tone, the window white. Drawn by the
  shell.
- From the one app colour the primitives derive its tones; a screen
  never mixes its own:

  | Tone | Token | Used for |
  | --- | --- | --- |
  | tint | `--k2-app-tint` | object head, open row, current sidebar entry |
  | soft | drawn by the primitive | data figures (R9) |
  | ink | `--k2-app-text` | hero figure, current entry, open row's name |

- Tint only for the object head, selection, active filters, choice cards
  and notices. Cards (1 px) only for choices, tiles and islands. No shadow
  on controls. Rows of another app carry that app's colour.
- Colour only for problems: an OK state is a small dot and the plain word
  ("● Liefert"); a warning an amber dot and its word in amber, 500; a
  failure a red dot and its word in red; a paused or empty state a grey
  dot and a muted word. No green chips, no chip in every row.

### R11. Filters are sentences

Active filters stand as statements in the app tone (field · operator ·
value · ×) with "und" between them; saved views are head tabs with a
count; the result count and the sort in words stand in the status row;
"Zurücksetzen" appears as soon as anything differs. On the phone: one line
and a sheet with "N zeigen". See [list queries](list-queries.md).

### R12. States fully designed

- Loading: placeholder rows in the real row height and column width.
- Empty: a mark of 40 px + a sentence 15/600 + one sentence + one action,
  centred in the area it replaces.
- Failed: its sentence and "Erneut versuchen" where the data would stand.
- Unsaved: a floating bar at the bottom centre.

### R13. White space only under finished content

White under the content only when the first screen shows at least 60 %
real content, or the page is a complete short setting. Otherwise a topic
is missing (inheritance, link, history), not spacing. More information
per screen than a classic admin page, but each fact once. This is a
review rule.

## Two reference screens, in words

**A list of sign-in clients.** The head holds the views and "Neuer
Client". Under it the hero: "178 aktive Verbindungen", "97 Personen · 23
neu in 7 Tagen", beside it 30 days of new connections as bars, today in
the app colour; below, two exceptions: "2 selbst registriert · Claude Code
neu seit Mo." and "● 1 ungenutzt seit 30 Tagen · MCP Inspector". The table
shows each client with its letter mark, its kind as a quiet badge, who may
use it, a stack of the people connected, the count and the last use. The
open client, Paperless, has its row in the tint and a tinted head: its
sign, "Paperless", "Belegablage der Buchhaltung · vertraulich" and three
facts: "Verbunden 6 von 6", "Zuletzt vor 1 Std", "Angelegt 02.10.2026". On
a large screen the detail shows people per day, access and technical facts
on the left, the connected people and the history on the right.

**A list of metric sources.** The hero: "Werte heute" with the day's
count, "seit 00:00 · 6.612 Serien", beside it the values per hour;
exceptions: "● 6 liefern Daten", "● 1 Fehler · Drucker Halle 2 seit
10:40", "● 2 ruhen · 1 pausiert · 1 neu". Each row: the source's mark, its
state as dot and word, 30 minutes of fetches as ticks (one red tick where a
fetch failed), the values today, the last fetch. The open source has its
problem in its tinted head: "Liefert seit 10:40 keine Werte ·
Zeitüberschreitung nach 15 s, 3 Abrufe in Folge · Alarm an Felix Thal und
Lena Hartwig", and its latest fetches as a short table with times in
monospace.

## When a part is missing

The hero and the tinted object head come from `@k2b/ui` parts. Where your
version does not have them yet, build everything else of the page, put the
hero's figure and trend in a `Cells` cell with `trend`, and write the gap
at its place with the rule it misses, so it is found and replaced:

```tsx
// k2b-ui gap: hero (look.md R9)
// k2b-ui gap: tinted object head (look.md R2)
```

A gap is named in the report; it is never a reason to ship the screen
bare.
