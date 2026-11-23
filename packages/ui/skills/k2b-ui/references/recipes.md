# Recipes

A recipe is a whole screen in one file under `recipes/`, with sample data at
the top and one default export. Copy the file, keep its structure, replace
the data. The pictures in `images/` are drawn from these files by
`packages/ui/scripts/v2-preview.ts` (light, 1440 and 390 px), and a browser
test keeps every recipe free of findings, so code and picture always match.

Read the recipe file next to its picture: each part in the code is one
thing you can point at in the image.

## list-detail.tsx: a list beside the open entry

![list with detail at 1440 px](../images/list-detail-1440.png)
![list with detail at 390 px](../images/list-detail-390.png)

`Workspace` with `Nav`, a head `Bar` with `Tabs` and the main action;
`Pane.Split` with the list (`StatusRow`, `List` of two-line `Row`s, the open
one `selected`) and a `Pane detail` (head `Bar` with the name and actions,
`Notice tone="bad"` with a way out, `Section`s with `Facts` and `Row`s).

- On the phone the detail pane leaves. Open an entry as its own route there.
- An error of the open entry is a `Notice` at the top of the detail, not a
  red text somewhere.

## form.tsx: a form with server errors and a conflict

![form at 1440 px](../images/form-1440.png)
![form at 390 px](../images/form-390.png)

`Notice tone="warn"` for a conflict that blocks saving; `Band`s of `Field`s
(`Field.Row` for fields side by side); a server error goes into the `error`
of its field; `Choice` and `Check switch` for options; a `Bar` at the end
with "Cancel" and the one primary "Save", disabled while the conflict lasts.

- Validation and server answers live in the app's state; the primitives
  only show `error`.
- Until v2 has a `Dialog`, the form stands in its own pane or route.

## record.tsx: a record, first tab

![record at 1440 px](../images/record-1440.png)
![record at 390 px](../images/record-390.png)

`RecordHead` in the head `Bar`; `Tabs` as the head of the record's `Pane`.
Across both columns: a pinned `Notice tone="note"` and `Cells` with the key
statements. Below them a `Pane.Split`: the main column with
`Section "Anstehend"` (`Row yours`, row actions) and a `Section` with a
`Digest` and a `more` link; a `Pane side` with a `Canvas` (map) and
`Section` + `Facts`.

- What needs a person comes first; history comes after.
- Area colours (`color`) mark the same area in cells, sections and groups
  (tabs carry no colour).

## record-groups.tsx: a record tab with groups

![record groups at 1440 px](../images/record-groups-1440.png)
![record groups at 390 px](../images/record-groups-390.png)

One `Section` for the area with a `summary`; one `Group` per delivery with
`meta`, a `state` chip and actions. Inside a group: a strong sentence, its
way as `Steps`, a `Table` with two-line cells and `Progress`, `Facts inline`
with a print button. A finished group is `folded`.

- Never a `Group` inside a `Group`, never a line inside one.
- "You are next" is `Chip yours`, not a red badge.

## mail.tsx: a list with a reader

![mail at 1440 px](../images/mail-1440.png)
![mail at 390 px](../images/mail-390.png)

Three-line `Row`s (sender, subject, preview) with `unread`, `meta` count,
`time` and `marks`; `StatusRow` with select-all. The reader: head `Bar`
with the subject as `Text type="lead"` and actions; a `Bar` with `Inline`
chips; `Notice tone="ai"` for the summary; one `Band` per message with a
sender `Row` (avatar, icon buttons in `end`), `Prose`, `Tiles`.

- A colleague's internal note in the thread is a `Notice tone="note"` with
  `title` and `meta` (who, when).
- The reply: until the composer of `@k2b/editor` arrives (gap), a `Band`
  with a `Field` and `<Input multiline />`, followed by a `Bar` whose `end`
  holds "Senden" as a default button (the page's primary stays "Neue
  Nachricht").

## table.tsx: a table with a status row

![table at 1440 px](../images/table-1440.png)
![table at 390 px](../images/table-390.png)

`StatusRow` with the lead ("3 offen"), facts (sum, overdue) and a filter
button at the end; `Table` with widths, a status `Chip`, an amount column
`align: "end"`, one text button per row, and `drop` on the columns that
matter least. With no rows: a `Band` with `Text muted`.

- The lead says the one thing; the rest are facts, which leave on the phone.
- A deed per row is a `Button variant="text"` in its own last column.
