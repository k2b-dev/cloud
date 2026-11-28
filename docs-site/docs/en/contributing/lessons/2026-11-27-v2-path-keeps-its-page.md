### A v2 path cut the page it names

- **What happened:** In Spaces, the path of the settings page showed "Space settin…": the long Space name before it took the room, and the page itself was cut.
- **Root cause:** `.k2-bar-start > *` is `flex: none`, so a `Path` never shrank. It ran over its room, and the head cut it at its end, where the current page stands. Nothing shortened the places before it, and nothing folded them.
- **Error class:** A row of parts that lets the browser cut at the end, when the most important part stands last.
- **Guard:** `packages/ui/src/v2/path.browser.test.ts`, at 390, 1024 and 1440 px in Chromium and WebKit, with a long Space name, a deep path and a page whose own name is too long (three and five places), in a head beside actions and in a pane. It checks:
  - The page never runs past the path.
  - A cut page ends in "…".
  - Every place that shows keeps its own width or 12 characters.
  - The middle places fold into "…" only when they have no room at that least.
  - The server sends every place, and on a wide screen coming alive moves neither the page nor any place; only at 390 px does a path without room fold, once.
  - A folded place is no stop of the Tab key and hands its focus to "…".
