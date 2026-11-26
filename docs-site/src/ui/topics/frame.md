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
- **Phone (below 768 px):** the sidebar leaves, and head actions hide unless they have `keep`. The main action floats at the bottom right from `Workspace primary`. The list is the page; an open entry is a page of its own.
- **One way back:** on the phone, the open entry's `Pane back` is the one way back to the list, with the list's address as `href`. The close × of its head gives way there, so there are never two.

## Tabs or path?

### Tabs

- Views of the same thing: "Offen", "Diese Woche", "Erledigt", or the areas of a record.
- They stand in the head `Bar start` beside the actions, or as the `head` of a `Pane`.
- A tab without room hides whole and joins the menu tab ("Weitere").
- Tabs with `href` change the address and are a navigation. Tabs without any `href` switch a panel in place ("Vorschau | Code") and are the tabs pattern of assistive technology: give them `panel` and put the content in `Tabs.Panel`. The arrows, Home and End move between the tabs that show. A segmented control is never tabs; it chooses a value.

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

### Tabs.Panel

The content of tabs that switch in place; the open tab names it and controls it.

<Props of="Tabs.Panel" />

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
