---
thumbnail: actions
---

# Actions and menus

Where deeds stand: the page's deeds in the head, an entry's deeds in its row and behind its "…", the same deeds on a right-click, and a small panel behind a button. A deed is a `Button`; more deeds wait in a `Menu`.

## Deeds in the head and in the rows

Offers of a workshop. The head holds the views, a hint on the refresh button, a filter panel, a view menu with one choice and two toggles, and the one main action, "Neues Angebot", a menu of its own. Each row has a star that is pressed or not and its deeds behind "…"; a right-click or a long press on the row opens the same menu. Switch the state: "Open" shows the offer the address names beside the list with its own deeds, "Sending" turns "Senden" while it sends, and "Menu" and "View" open the menus.

<Example recipe="actions" height="560" default="List" />

- One main action per page: the filled `primary` in the head, mirrored as `Workspace primary` so the phone shows it.
- A deed that cannot be taken now is `disabled`, and a sentence beside it says why, such as the `Notice` "Freigabe fehlt".
- A deed under way is `busy`: the button keeps its width, its look and the focus, and takes no second press.
- A toggle is `pressed`: `true` on, `false` off. Never on a link or on the primary action.

## Menu or popover?

### Menu

- The person picks one deed or one option, and the menu closes.
- Entries, sections under a heading, a choice with a tick, toggles, a submenu, a red deed after a line.
- The same entries go to the row's "…" and to its `Menu.Context`.

### Popover

- The person sets several things and looks at the page while doing so: filters, a short preview.
- A panel of primitives (`Check`, `Field`, `Facts`, `Text`) under a title.
- With `tip` it is a short hint on one button instead.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### Button

The one button: `primary` once per page, framed by default, `ghost` and `text` for quiet places; `busy`, `pressed` and `disabled` for its state.

<Props of="Button" />

### Menu

More deeds behind a button or behind "…": items, sections, one choice, toggles and submenus. An entry whose `onClick` returns a Promise keeps the menu open and turns until it settles.

<Props of="Menu MenuItem MenuSection" />

### Menu.Context

The same menu on the thing itself: a right-click or a long press at the pointer, Shift+F10 or the context menu key at the thing. It adds no wrapper, so a `Row` stays a child of its `List`.

<Props of="Menu.Context" />

### Popover

A panel behind a button: Escape and a press outside close it, the focus moves in and back. With `tip`, a hint after a moment on hover or focus.

<Props of="Popover" />

## Not in v2 yet

A `Popover` in the head has no `keep`: on the phone it leaves with the other head actions, while a `Menu` in the head stays. A filter the phone needs stands in a `Menu` until then. Write `// k2b-ui gap: popover keep on the phone` at that place.

## Do and don't

### Do

- Give a row's "…" and its `Menu.Context` the same list of entries.
- Name every icon button and every "…" with `label`, such as "Aktionen für Regal Archiv".
- Put deeds that destroy last, with `danger`; the line before them comes by itself.
- Say why a deed is disabled, in the sentence beside it.

### Don't

- Put a second `primary` on a page, or confirm a dialog with `Workspace primary`.
- Hide a deed only in `Menu.Context`; not everyone right-clicks.
- Open with `onClick` what has an address; give the entry an `href`.
- Build a menu or panel of your own from a `Band` or a `Section`, or switch views with a segmented control: views are `Tabs`, a segmented control only chooses a value.

## Next

[Dialogs and overlays](/en/ui/v2/dialogs-and-overlays)
