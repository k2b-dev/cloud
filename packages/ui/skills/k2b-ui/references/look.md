# The look

Every v2 screen follows this page. A screen that is clean but bare is not
done: grey text between lines, one weight for everything, no colour of its
app, nothing that shows the shape of its data. People reject such screens
as "wireframes". This page says what a screen must have instead, with
exact values, and how to check your own screen before you call it ready.

The values come from the approved design reference for v2 (direction
"self-assured": quiet lines, one clear hero, the app's colour where it
means something). The primitives draw most of it; your job is to choose the
right primitive, feed it real data and leave nothing out.

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

### 2. Start from a recipe, not from parts

Open the recipe that is closest to your screen (see
[recipes](recipes.md)), copy it, keep its composition and replace the data.
A screen assembled from single parts reads as a random first draft even
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
- the title repeats the open entry of the sidebar, or a fact appears twice;
- a 1920 px window shows the 1440 px layout stretched.

Check the list against the picture at each of the four widths, and name in
your report which rule each fix answers.

## The rules

### 1. One hero per screen

Right under the head stands the one figure or statement that matters
today, with its real trend beside it, and below them a line of
exceptions. It is the only figure of its size on the screen.

- Figure: 600 30px/34px, letter spacing −0.015em, in the app's ink colour.
- Under the figure: what it counts (500 14px/20px) and one meta line
  (12px/16px), such as "97 Personen · 23 neu in 7 Tagen".
- Beside it: its trend, 56 px high, as bars (3 px gap, radius 1.5 px) or an
  area. Today in the full app colour, earlier days in its soft tone, days
  without data in n200. Under the chart a caption line: start date, what
  it shows, "heute".
- Below, after a quiet line: the exceptions, each as "● number word ·
  who" (a state dot, the number bold, the word, the meta). Only real
  exceptions; never their own rows or cards.
- Band: 18 px above, 14 px below, 20 px edge; 14 px between its rows and
  32 px between figure and chart. On the phone figure, chart and
  exceptions stand one under the other.

Pick the figure from the brief: the count or amount a person acts on, not
the size of the table.

### 2. The app's colour says whose thing it is

The shell's tint (page background, rail) says where you are. The app's
own colour, the owner colour, marks what belongs to it: the hero figure
and its chart, the open row, the current tab's underline, the current
sidebar entry and the head of the open object. It is never decoration.

From the one app colour come four tones:

| Tone | Mix | Used for |
| --- | --- | --- |
| tint | 7 % on white | object head, open row, current sidebar entry |
| tint 2 | 12 % on white | a stronger ground, such as a pressed control |
| soft | 32 % on white | earlier bars, OK ticks |
| ink | 82 % with black | hero figure, current entry, open row's name |

Rows of another app on your page carry that app's colour, not yours.

### 3. Every list shows the shape of its data

Exactly one column of a row carries data over time, where the data
exists: ticks, a spark or a stack of people. Never two pictures in one row,
never a picture as decoration.

- Ticks: bars 3 px wide, 12 px high, 1 px apart; a good beat in the app's
  soft tone, a failure 16 px high in red, no data 4 px high in n200.
- Spark: bars or a line in the soft tone, the last value in the full
  colour.
- People: `Avatar.Stack` of 20 px avatars overlapping by 5 px, "+n" as
  meta.

Red only for failure. A column of numbers stands right-aligned in tabular
figures.

### 4. Rows keep one height

On the desktop a row is one line: a table row is 46 px, its name cell
leads with the thing's 28 px mark and the name in weight 500. On the
phone every row is two lines: the name, then its meta joined by "·", 60
px high. Descriptions belong in the detail, not in the row.

### 5. The open object has a tinted head

The object a person opened gets a head in the owner tint:

- 14 px above, 16 px below, 20 px edge on the left, 12 px on the right;
- its sign as a 40 px mark (radius 10 px), the name in 600 18px/24px and
  one meta line under it (12px/16px, muted);
- three key facts as label over value: the label 12px/16px meta, the value
  600 15px/20px, 28 px between the facts, 14 px under the name;
- a problem stands right there in red: its icon, one line in weight 500
  and a 12px/16px reason under it ("Liefert seit 10:40 keine Werte ·
  Zeitüberschreitung nach 15 s");
- its deeds at the right of the name: one small button, a quiet "…", the
  close ×.

### 6. Two line weights

The primitives draw two lines. Do not add your own.

- The clear line (`--k2-hairline`, n200) separates what must be told
  apart: a head from its content, a column head from the rows, a list from
  its detail, one section from the next, a frame.
- The quiet line (`--k2-hairline-subtle`, n100, where your version of
  `@k2b/ui` has it) separates rows of a list or table.
- No lines between the columns of a table, and never two lines at one
  edge.

### 7. Colour only for problems

An OK state is a small dot and the plain word in normal ink, without a
ground ("● Liefert"). A warning is an amber dot with its word in amber,
weight 500; a failure a red dot with its word in red; a paused or empty
state a grey dot with a muted word. No green chips, no tinted pills for
OK, no chip in every row.

### 8. Five type steps

| Step | Value | For |
| --- | --- | --- |
| meta | 400 12px/16px | labels, counts, times, captions |
| row | 400 13px/20px | rows and most text |
| body | 400 14px/20px | reading text, section heads (600) |
| lead | 600 18px/24px | the open object's name, a phone title |
| figure | 600 30px/34px | the hero figure, once per screen |

Numbers use tabular figures. A count is meta text, never a heading.

### 9. Dense, not busy

- Head 56 px; a toolbar under it 44 px; a table's column head 34 px on
  n50 with clear lines above and below.
- Detail sections: 4 px above, 14 px below, their head 40 px; facts as a
  grid with a 116 px label column (100 px on the phone), 8 px between
  rows, 16 px between label and value; feed entries 7 px above and below.
- Text edge 20 px, 16 px on the phone.
- More information per screen than a classic admin page, but each fact
  once.

### 10. Settings are rows, not a form letter

A setting is its label and a one-line hint on the left and its value at a
fixed width on the right (`Setting`), with its current state visible at a
glance. Sections are split by a clear line. Never full-width fields
stacked one under the other.

### 11. The phone is dense too

- The page's views sit in a 44 px head; there is one search place.
- The main action floats at the bottom right (48 px high); the end of
  every scrolling column keeps 72 px free, so the last row stands above it.
- Tables become two-line rows of 60 px with their mark.
- The hero stands as figure, chart, exceptions; the object head keeps its
  tint, its facts wrap with 20 px between them.
- An open object is the page, with its way back.

### 12. Large screens use the room

From about 1680 px the list keeps its ideal width (about 640 px) and the
open detail grows into two columns under its one head:

- left, what it is: its chart, access, technical facts;
- right, who and what happened: people, alarms, history.

Build it as a `Pane.Split` of a `Pane` and a `Pane side` inside the
detail, after anything that spans both columns. A table without a detail
gets a context column (`Pane side`) beside it on a large screen. Never a
wider list, never an empty half.

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

The hero band and the tinted object head come from `@k2b/ui` parts. Where
your version does not have them yet, build everything else of the page,
put the hero's figure and trend in a `Cells` cell with `trend`, and write
the gap at its place, so it is found and replaced:

```tsx
// k2b-ui gap: hero band (look.md rule 1)
// k2b-ui gap: tinted object head (look.md rule 5)
```

A gap is named in the report; it is never a reason to ship the screen
bare.
