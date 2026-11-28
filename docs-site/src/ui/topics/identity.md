---
thumbnail: overview
---

# Things and people

Every thing that has a face shows it, and every person stands beside what they did. A base, a storage, a file or a table leads with its `Mark` in the sidebar, in its rows and on its card; people show as `Avatar` or `Avatar.Stack`, and what they did as an activity in `Digest`.

## An overview of things

The bases of Grids: each base is a card with its mark, its figures, the people who work in it and its changes of the last seven days. The same mark leads the base in the sidebar and in a sentence of the activity beside it. The last card makes a new base, with templates as quick choices. Switch the state: a new installation without a base.

<Example recipe="overview" height="720" default="Bases" />

## The home of one place

One base: key numbers with a short history in `Cells`, then its tables, forms and workflows as rows with the mark of their kind, their figures and their state, then who changed what. Switch the state: a quiet day without anything that needs a person.

<Example recipe="home" height="720" default="Busy" />

## A first start

An app without any data yet: no sidebar, one line in the middle and four cards, the blank way first. Each card previews what it makes (a page, a table, or its sign) and opens the dialog that makes it. Four share a row on a wide screen and stand 2 × 2 on the phone. Switch the state: the first base in Grids.

<Example recipe="start" height="560" default="Notizbücher" />

## Mark, symbol or avatar?

### Mark

- The row, tile or entry stands for a thing: a base, a file, a table, a mailbox.
- The thing has a colour or a picture; without its own, it takes the colour of its kind.

### Symbol

- The row is a deed or a plain place, such as "Übersicht" or "Papierkorb".

### Avatar

- The row stands for a person, or for who did something.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### Mark

What a thing looks like: its symbol on a tint of its colour, or its picture with a type such as `PDF`; the place sets the size.

<Props of="Mark" />

### Cover

A picture across its place, such as the banner of a place at the top of its page or detail: directly in the `Pane`, from edge to edge, cut to its height with nothing distorted. The height follows the width of the place alone, a third of it from 120 to 180 px, so the server's page already holds the room and nothing moves when the picture comes. `slim` is for a cover above a task, such as a form, that only says where the person is: a sixth of the width, from 72 to 88 px. While the picture loads, and when it fails, a quiet tint fills the room in light and dark. Without a `src` there is no cover at all, never an empty band. Its `alt` says what the picture shows; give `""` when it is decoration, such as a banner right above the name of its place.

<Props of="Cover" />

### Avatar.Stack

People over each other with "+n" for the rest, as one picture with one name.

<Props of="Avatar.Stack" />

### Spark

A few bars of a short history beside a number or on a card, the last in full colour. Sparks side by side that people compare share one `max`, so the same value has the same height in each.

<Props of="Spark" />

### Tiles card

Things as cards: mark, name, figures, people and a short history; the last card makes a new thing. A card can preview what it holds across its top (`preview`), and with `onOpen` the whole card is one button. `perRow` sets how many share a row.

<Props of="Tiles Tile TileStat TileCreate TilePreview" />

### Digest activity

Who did what: an avatar, one sentence with the thing's mark and name, then where and when.

<Props of="Digest ActivityEntry" />

## Not in v2 yet

- A card or row that shows several pictures of a thing, such as the photos of a folder.
- Live activity that grows while the page is open: render it on the server and refresh the region.

Until they ship, use the nearest part and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Give each thing its mark wherever it appears, with the same colour and symbol.
- Give a kind of thing (table, form, workflow) one colour across the app.
- Write an activity as one sentence: who, the deed, the thing with its mark.
- Show a state on a card or row as a chip or a figure with its tone and its word.

### Don't

- Lead a row for a thing with a plain grey symbol when the thing has a colour.
- Use a `Spark` instead of the number it explains.
- Put a second card or a box inside a card.
- Colour a mark for decoration; its colour comes from the data.

## Next

[Lists and tables](/en/ui/v2/lists-and-tables)
