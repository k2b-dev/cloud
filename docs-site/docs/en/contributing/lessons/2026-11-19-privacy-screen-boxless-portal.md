### The privacy screen left windows and toasts sharp or moved them away

- **What happened:** With the privacy screen on, a Mail compose window, maximized or normal, stayed sharp and readable;
  only the page behind it blurred. Where a modal dialog was open, windows vanished from view instead.
- **Root cause:** The privacy screen blurs each child of `body` with `filter` and `opacity`. The `@k2b/ui` portal root
  (`.k2b-ui-portal`) is such a child and has `display: contents`, so it has no box and paints no filter: everything
  portaled into it kept its look. Where the cover went deeper, it blurred the portal's wrapper `<div>`, and a filter
  makes its element the containing block of the fixed window inside, which moved the window out of view.
- **Error class:** A visual effect (filter, opacity, transform) set on a container without regard to its box: on a
  boxless element it applies to nothing, and on an ancestor of fixed elements it moves them.
- **Guard:** The cover goes into every `display: contents` element and every element above a fixed element whose
  containing block a filter would change, and blurs the children instead. The browser test "every overlay layer
  covers" opens each `@k2b/ui` overlay layer with and without a modal dialog, requires a blurred ancestor with a box
  below each layer's top layer, and requires every layer to keep its place and stay in view.
