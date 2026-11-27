---
thumbnail: record
---

# Record and detail

One thing with everything about it: a customer, a contract, a delivery. The record's name stands in the head, its areas are tabs, and what needs a person comes before its history.

## A record, first tab

A customer file: `RecordHead` in the head, the areas as `Tabs` over the pane, a pinned note and the key statements in `Cells` across both columns, then the main column beside an info column. "Anstehend" comes first, the history after. Switch the state: the history loads on its own, so its state stands in its section and the rest of the record stays.

<Example recipe="record" height="640" default="Customer" />

## A tab with groups

The deliveries of the same customer. A `Band` in a tone carries the one statement of the tab; each delivery is a `Group` with its way as `Steps`, a small table and its facts. A finished delivery is folded to its head.

<Example recipe="record-groups" height="640" default="Deliveries" />

## Section or group?

### Section

- A titled part of the page: "Anstehend", "Vorgänge", "Kontakt". A long title, such as a question, wraps.
- Rows, `Facts`, a `Digest` or groups stand directly in it.
- One line at its end, none under its head or between its entries.

### Group

- What belongs together inside a part: one delivery, one thread.
- A frame with a tinted head, no line inside, `folded` when it is done.
- Never in another group and never in a `Band`.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code. The record's areas are [Tabs](/en/ui/v2/frame).

### RecordHead

The identity of the record in the head `Bar start`: picture, name, kinds and identifiers that give way when room is short.

<Props of="RecordHead RecordId" />

### Cells

Two to four key statements side by side, with the area's colour; one under the other on the phone.

<Props of="Cells Cells.Cell" />

### Section

A titled part with a count, at most two text buttons, a summary and one link to all of it at the end.

<Props of="Section" />

### Group

What belongs together, framed: a head with a state, deeds and `meta`; `folded` when done.

<Props of="Group" />

### Band

One statement that stands out in a column, in a tone; free height and one line below.

<Props of="Band" />

### Facts

Labels with their values; `copy` for what people paste elsewhere, `mono` for keys and IDs, `inline` for one line.

<Props of="Facts Fact" />

### Steps

The way of a thing in a few steps: done, the one running now, and those still to come.

<Props of="Steps Step" />

### Digest

The newest few on a first page, without lines: date, number with state, and one sentence.

<Props of="Digest DigestEntry" />

## Not in v2 yet

Nothing is known to be missing for records. If a record needs something these parts cannot show, use the nearest part and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Put `RecordHead` in the head `Bar start` and the record's areas in `Tabs` as the head of its pane.
- Show what needs this person first (`Row yours`, `Chip yours`) and the history after.
- Mark one area with one colour, the same in cells, sections and groups.
- Let a part that loads on its own show its state in its own section.

### Don't

- Put a `Group` in a `Group` or in a `Band`, or draw a line inside one.
- Mark "you are next" with a red badge; use `Chip yours`.
- Use a `Band` for a message with a title and deeds; that is a `Notice`.
- Add a second primary for the record; its deeds are section and group actions.

## Next

[Forms and input](/en/ui/v2/forms-and-input)
