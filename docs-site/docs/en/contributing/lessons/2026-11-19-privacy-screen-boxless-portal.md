### The privacy screen left windows and toasts in the portal root sharp

- **What happened:** With the privacy screen on, a Mail compose window, maximized or normal, stayed sharp and readable;
  only the page behind it blurred.
- **Root cause:** The privacy screen blurs each child of `body` with `filter` and `opacity`. The `@k2b/ui` portal root
  (`.k2b-ui-portal`) is such a child and has `display: contents`, so it has no box of its own and paints no filter.
  Everything portaled into it, such as `FloatingWindow` and toasts, kept its look. A modal dialog hid the fault in
  tests: it holds the hint, so the cover descended into the portal root and blurred its children one by one.
- **Error class:** A visual effect (filter, opacity, transform, clip) set on an element without a box, which applies
  to nothing while the attribute and the computed style still claim it does.
- **Guard:** The cover descends into every `display: contents` element. The browser test "every overlay layer covers"
  opens each `@k2b/ui` overlay layer with and without a modal dialog and counts a layer as covered only when a blurred
  ancestor with a box of its own lies below its top layer.
