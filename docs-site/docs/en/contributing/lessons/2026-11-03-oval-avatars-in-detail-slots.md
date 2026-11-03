### Avatars with a picture showed as ovals in the Notebooks detail panel

- **What happened:** In the note details, comment avatars with a profile picture were 20 px wide and 24 px tall: ovals instead of circles.
- **Root cause:** A picture avatar is an `<img class="k2b-avatar">`. The detail slot rule (1.25rem) and Avatar's `data-size="xs"` rule (1.5rem) have the same specificity, and the size rule loads later, so it won. The base image rule `max-width: 100%` then squeezed only the width into the 20 px slot column.
- **Error class:** A slot that resizes a shared component relies on stylesheet order against the component's own size rules, and an element-level base rule changes one axis only.
- **Guard:** `.k2b-avatar` sets `max-width: none`, and every DetailPanel, Discussion, presence, and properties slot sizes `.k2b-avatar[data-size]`, so it wins regardless of order. `detail-panel.browser.test.ts` measures width equal to height for every avatar in the panel, pictures and initials, on desktop and phone.
