---
thumbnail: frame
---

# Frame

The working surface of an app: its places in the sidebar, its views and the one main action in the head, and the columns below. Every v2 screen is one `Workspace`; everything else stands in its slots.

## The frame of an app

Open orders of a workshop: the sidebar holds the app's places, the head holds the views as tabs and "Neuer Auftrag", the list has its status row, and the open order stands beside it. What is open is in the address, so reload and back show the same. Switch the state: with nothing open, the detail's place says so, and nothing moves when an order opens.

<Example recipe="frame" height="560" default="Open" />

## Tablet and phone

The workspace decides from its own width, on the server's page too, so nothing jumps when the page comes alive. Switch the example to 1024 and 390 px to see each.

- **Tablet:** where the sidebar at its default width does not fit beside every column at its minimum, it becomes a drawer behind a button at the start of the head. A declared `detail` counts also while it is closed, so the sidebar does not jump when an entry opens.
- **Context column:** in a split of one main column and a `Pane side` after it, the context stands beside only where the split holds both at their default widths. With less it gives way to the end of the main column at its full width, and the split scrolls in one piece: the main column is never squeezed, and nothing hides. `side={{ from: 1400 }}` asks for a large screen (a table that needs its room). It needs no room of the workspace, so the sidebar never becomes a drawer for it. A list, its reader and an info column stay beside each other as before. Put `side` on the inner column only: an outer `Pane detail` with `side` becomes the list's context column and moves under the list. A split with no measuring place above it (in a dialog, a sidebar, outside a `Workspace`) never gives way.
- **A split inside a column:** a column whose content is a split (a list of folders beside the files) asks the workspace for what the panes of that split need beside each other, so the sidebar becomes a drawer before the split runs past the window. A detail in it counts through the workspace's `detail`, open or closed (Files: `detail={320}`), so the sidebar does not jump when it opens. What stands in a dialog or a popover asks the workspace behind it for no room.
- **A detail that grows:** the same part inside a `Pane detail`, under its one head: what it is on the left, who and what happened in a `Pane side` on the right. From a window of ~1680 px beside a list of 640 px it stands in two columns, below that in reading order.
- **Phone (below 768 px):** the sidebar leaves, and every head action stays (`keep` is deprecated and changes nothing). The main action floats at the bottom right from `Workspace primary`; its twin in the head carries `floats` and leaves the head there. A head gives way only when it holds nothing but where the page stands: its path, its search and that twin. Any other control, such as a menu "…", keeps the head at its height. The list is the page; an open entry is a page of its own.
- **One way back:** on the phone, the open entry's `Pane back` is the one way back to the list, with the list's address as `href`. Mark the close × of its head `Button closes`: it gives way there, so there are never two.
- **Narrow head:** below 600 px a head control with a symbol keeps only the symbol; its words stay its name. A menu keeps its chevron.
- **The bar names the page:** a pane with `back` and no `head` of its own, such as an editor whose name stood in the workspace's head, shows its `label` after the way back on the phone: "‹ Werkstatt  Notizen.md". The way back takes at most half the bar and is cut first; its whole name stays its hint.

## Tabs or path?

### Tabs

- Views of the same thing: "Offen", "Diese Woche", "Erledigt", or the areas of a record.
- They stand in the head `Bar start` beside the actions, or as the `head` of a `Pane`.
- A tab without room hides whole and joins the menu tab ("Weitere"); its focus moves to the menu tab, never to the page.

### Path

- Where a sub-page stands: "Lager › Halle 1"; the last item is the page itself.
- It stands in the head `Bar start` instead of tabs, and takes the room the actions leave; the actions keep their words.
- Without room the places before the page shorten first, each down to its own width or 12 characters; the page itself shortens last, with "…".
- When the places do not fit even at that least, they go into a "…" that opens them as a menu: first the ones between the first place and the parent (from four places on), then all of them. The server sends every place, shortened; only a path without room even so folds, once, in the browser.
- On the phone the head with a path is hidden, and the shell's bar names the page.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### Workspace

One per screen: the sidebar, the head, the main action, and the columns; it turns the sidebar into a drawer where it does not fit.

<Props of="Workspace" />

### Pane

A column that scrolls, with no padding: a head, a status that stays, a `width` inside a split, and `detail`, `back` (on a wide screen too with `wideBack`) and `side`.

A pane's `head` and its toolbar (a `StatusRow` or `FilterBar` as its `status`) are one block: the head's `Bar` stands the toolbar between its start and its end, with no line between them, one line under the block, and the two rows close together. Where the pane is 1200 px or wider, they stand in one row: the path, then the filters and how the list shows, then the head's actions; the Tab key follows that order. A head of actions only (a `Bar` without `start`) always shares the toolbar's row. Any other status, such as the state of an open entry, keeps its own row under the head. So give the head of a list's pane to the pane (`Pane head`), not to the workspace, when the pane has a `status`. The head's search is `HeadSearch` in the head's `end`, with a `label`: it stands as its symbol, named by its label, and opens over its neighbours when pressed or with "/". Its words keep it open in the row, and Escape leaves it with its words. Its code comes with it, so a page whose heads have no search loads none of it. A row keeps its height when it carries a deed: on one line the time stands at the end and the deed after it; on the phone the deed takes the row under the text.

<Props of="Pane" />

### Bar

A bar of fixed height with one line below and two places, `start` and `end`; its height comes from its place. The `start` keeps a least: its name at `--k2-start-least` (16ch), or its open tab. Buttons of the `end` that do not fit beside the whole `start` move into a menu "…" at its end, in their order, or into the end's own `Menu` "…" (one without a symbol of its own, whatever its `label`) as its first section, so a bar never shows two "…" (an end made outside the `Bar`, in an island of its own, gets the bar's "Mehr in dieser Leiste" instead); the primary action, a closing ×, a menu and a search stay; people shown in the end (an `Avatar` that is no button) give way with the buttons, unlisted. Only when nothing more can fold does the `start` shorten its words with "…", down to its least, never to nothing. In a workspace's head the tabs go first, whole tab by whole tab into "Mehr", and the title last, so a Space's name keeps its words beside its views.

<Props of="Bar" />

### Nav

The app's places in the sidebar: groups with a heading and a deed, counts, dots, folding entries and a foot.

<Props of="Nav NavGroup NavItem" />

### Tabs

Views of one thing; a menu tab at the end holds the views without a tab of their own.

<Props of="Tabs Tab" />

### StatusRow

Under the head while the column scrolls: the one statement, key figures and filters.

<Props of="StatusRow StatusFact" />

## Not in v2 yet

- A `false` child of `Pane.Split` still gets a line of its own. Render a pane that is not there as `undefined` (`open && <Pane … />` with `open` undefined), never `false` ([#4147](https://github.com/k2b-dev/cloud/issues/4147)).
- In a `StatusRow` of a 400 px column, a second fact runs into the filter button. Keep one fact there; the lead says the main thing ([#4149](https://github.com/k2b-dev/cloud/issues/4149)).

Until they are fixed, use the nearest part and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Put the app's places in `Nav`, its views in `Tabs`, and its main action in the head and in `Workspace primary`.
- Render the detail only while the address names an entry, and give its `back` the list's address.
- Declare `detail` and `detailEmpty` on the workspace when a detail opens beside the list. While nothing is open, `detailEmpty` may carry a `hero`: a picture of the place as a whole, such as a [`Heat`](/en/ui/v2/content) of the mails received per day with a line that sums it up.
- Give a long list a `scrollKey`, so back and forward return to where it was.

### Don't

- Put views or filters in the sidebar: a tag filters, it is no place.
- Open an entry with `onClick` when it has an address.
- Give the open entry a second way back on the phone.
- Add padding, gaps or lines of your own; the panes own them.

## Next

[Lists and tables](/en/ui/v2/lists-and-tables)
