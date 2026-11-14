### A Notes test waited for CodeMirror's hidden widget buffer instead of the image

- **What happened:** `Notes: slash menu > /tabelle continues in a cell; /bild takes an image and a PDF` failed again and again on pull requests that do not touch Notes, mostly in WebKit (#2438): it waited 5 s for `.cm-content img` to become visible.
- **Root cause:** CodeMirror inserts hidden `<img class="cm-widgetBuffer" aria-hidden="true">` elements next to inline widgets to keep the caret usable, more often in WebKit. `locator(".cm-content img").first()` resolved to such a buffer (the CI log showed "14 × locator resolved to hidden <img class=\"cm-widgetBuffer\">"), which never becomes visible, so the image that was already there did not count.
- **Error class:** A browser test selects a generic element inside an editor whose engine adds its own hidden elements of the same tag.
- **Guard:** The test waits for `.cm-content .cm-image-widget img`. The `codemirror-widget-buffer` rule flags any browser-test selector that reaches a bare `img` inside `.cm-content` without naming the widget or excluding `.cm-widgetBuffer`.
