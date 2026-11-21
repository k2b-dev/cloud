### The privacy screen left a selected row and bright sidebar areas recognisable

- **What happened:** With the privacy screen on in Mail, the blur covered the screen unevenly: the open
  conversation's row and bright rectangles in the sidebar stayed recognisable under it.
- **Root cause:** The privacy screen hid the page only with a `filter` on each covered element. Where a container
  cannot carry the filter (it has no box, holds a fixed element, or is static with absolute children), the cover
  passes through it to its children, and the container's own paint, such as a selected row's fill, keeps no blur at
  all. In Mail every conversation row passed through: `holdsFixed` counted the row's closed "…" menu, a `Dropdown`
  popover with `position: fixed` and `display: none`, as a fixed element. On top, the blurred parts at 66 % opacity
  let strong fills show through as bands.
- **Error class:** Hiding a region through many per-element effects: any part that cannot take the effect, or that
  paints outside it, stays visible, and the result depends on the page's structure.
- **Guard:** `holdsFixed` skips undisplayed children, popovers and modal dialogs, which paint nothing in place. One
  veil in the top layer lies over the whole screen with a tint and a backdrop blur, cut open only for islands. The
  browser test "one veil above every layer hides the whole screen evenly" requires a Mail-shaped row with a closed
  menu to carry its own blur, and the veil to be the topmost element at a selected row, the sidebar's active item,
  the app bar, a toast and a dialog that arrive later, with no layout shift; the sign-out warning stays above it.
  A behavior test covers browsers without the popover API, which get no veil.
