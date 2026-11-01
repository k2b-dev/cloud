### Checked checklist boxes showed square corners outside the Cloud shell

- **What happened:** In the public notes editor, a checked task-list box looked like a square purple block next to the rounded open boxes.
- **Root cause:** `@k2b/editor` styled its task marker with only `accent-color`. The browser then paints the native checkbox, and that paint ignores the design's corner radius. Cloud apps hid this because `packages/cloud/src/styles/input.css` replaces every native checkbox. Standalone consumers of `@k2b/editor` and `@k2b/ui/base.css` do not load that file.
- **Error class:** A shared package relies on a stylesheet of its consumer, so the look of a control changes with the page that hosts it.
- **Guard:** `packages/editor/src/markdown/task-marker.browser.test.ts` renders the editor task list and `base.css` without Cloud styles, in light and dark, and requires equal size, equal 4px radius and `appearance: none` for checked and open boxes.
