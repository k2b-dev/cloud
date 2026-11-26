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
- **Phone (below 768 px):** the sidebar leaves. In a head with a "…" (a `Menu` without words or a symbol of its own), the buttons without `keep` give way, and the "…" lists them by itself, with their names, states and deeds; a head without a "…" keeps them, so no deed vanishes unseen. The main action floats at the bottom right from `Workspace primary`. The list is the page; an open entry is a page of its own.
- **A head with a title, without room:** a head that names its page (a `Text` in `Bar start`) gives way below 1100 px of its own width, such as a laptop beside its sidebar. First its buttons without `keep` move into the "…", while the main action stays. Then its tabs give way, whole tab by whole tab, and its title is cut with "…" last. A head of tabs alone keeps its actions.

## The head as one block

- **One line:** the head and the toolbar rows of the column under it (a `FilterBar`, a `StatusRow` in the `Pane status`) are one block. No line stands between them, they stand 4 px apart, and the last row draws the one line under the block.
- **A toolbar in the head:** a `FilterBar` in the head's `Bar start` stands in the head line while the head has room. Below 1100 px of the head's width it wraps as the head's second row, without a line between.
- **The search is its symbol:** at every width, a search in the head shows only its magnifier while it holds no words. A click, a tap or "/" opens it over the title and the views. With words it stays open, also from the address on the server's page and on the phone, so a filtered list says so; emptied, it folds back. Escape takes the focus from it and keeps its words. A search without a placeholder shows its name as one. While a menu at the field's end is open (a filter), the field stays open.
- **The open item in the host's bar:** a page whose head shows where it stands with a `Path`, and whose open item has no title of its own (the Assistant's chat), names that item, the path's last step, to a host that names the page in a bar of its own: on the phone, Cloud's shell bar shows it instead of the app's name (`PageNameContext`).
- **Only the pane in front on the phone:** in a `Pane.Split`, a detail that is closed (`detail={false}`) stands beside the others on a wide screen and waits out of sight on the phone until it opens.
- **No title twice:** while the sidebar shows, a head title with the words of the sidebar's current entry ("Einstellungen", "Alle Ablagen") gives way; the head keeps its views, actions and toolbar. On the phone and where the sidebar is a drawer, the head names the page.
- **One main action:** the head's end holds the search and one main action. Where an app passes several (`variant="primary"`, such as "Hochladen" and "Neuer Ordner"), the head shows them as one "+" menu with their names and deeds. On the phone the main action floats as the round button from `Workspace primary`.
- **One way back:** on the phone, the open entry's `Pane back` is the one way back to the list, with the list's address as `href`. The close × of its head gives way there, so there are never two.

## Tabs or path?

### Tabs

- Views of the same thing: "Offen", "Diese Woche", "Erledigt", or the areas of a record.
- They stand in the head `Bar start` beside the actions, or as the `head` of a `Pane`.
- A tab without room hides whole and joins the menu tab ("Weitere").

### Path

- Where a sub-page stands: "Lager › Halle 1"; the last item is the page itself.
- It stands in the head `Bar start` instead of tabs.
- On the phone the head with a path is hidden, and the shell's bar names the page.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### Workspace

One per screen: the sidebar, the head, the main action, and the columns; it turns the sidebar into a drawer where it does not fit.

<Props of="Workspace" />

### Pane

A column that scrolls, with no padding: a head, a status that stays, a `width` inside a split, and `detail`, `back` and `side`.

<Props of="Pane" />

### Bar

A bar of fixed height with one line below and two places, `start` and `end`; its height comes from its place.

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
- Declare `detail` and `detailEmpty` on the workspace when a detail opens beside the list.
- Give a long list a `scrollKey`, so back and forward return to where it was.

### Don't

- Put views or filters in the sidebar: a tag filters, it is no place.
- Open an entry with `onClick` when it has an address.
- Give the open entry a second way back on the phone.
- Add padding, gaps or lines of your own; the panes own them.

## Next

[Lists and tables](/en/ui/v2/lists-and-tables)
