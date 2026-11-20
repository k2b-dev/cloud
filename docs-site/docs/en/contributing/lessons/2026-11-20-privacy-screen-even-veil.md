### The privacy screen left a selected row and bright sidebar areas recognisable

- **What happened:** With the privacy screen on in Mail, the blur covered the screen unevenly: the open
  conversation's row and bright rectangles in the sidebar stayed recognisable under it.
- **Root cause:** The privacy screen hid the page only with a `filter` on each covered element. Where a container
  cannot carry the filter (it has no box, holds a fixed element, or is static with absolute children), the cover
  passes through it to its children. The container's own paint, such as a selected row's fill, then had no blur and
  no fade at all, and the blurred parts at 66 % opacity let strong fills show through as bands.
- **Error class:** Hiding a region through many per-element effects: any part that cannot take the effect, or that
  paints outside it, stays visible, and the result depends on the page's structure.
- **Guard:** One veil in the top layer lies over the whole screen with a tint and a backdrop blur, cut open only
  for islands. The browser test "one veil above every layer hides the whole screen evenly" turns the screen on over a
  selected row whose fill the cover passes through, and requires the veil to be the topmost element at that row, the
  sidebar's active item, the app bar and a dialog opened later, with no layout shift.
