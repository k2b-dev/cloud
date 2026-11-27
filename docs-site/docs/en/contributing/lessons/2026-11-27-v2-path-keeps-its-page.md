### A v2 path cut the page it names

- **What happened:** In Spaces, the path of the settings page showed "Space settin…": the long Space name before it took the room, and the page itself was cut.
- **Root cause:** `.k2-bar-start > *` is `flex: none`, so a `Path` never shrank. It ran over its room, and the head cut it at its end, where the current page stands. Nothing shortened the places before it, and nothing folded them.
- **Error class:** A row of parts that lets the browser cut at the end, when the most important part stands last.
- **Guard:** `packages/ui/src/v2/path.browser.test.ts` checks at 390 and 1024 px, in Chromium and WebKit, a long Space name and a deep path in a head beside actions and in a pane. Every path keeps its current page whole and stays in its room, and the actions keep their words. A deep path without room folds the middle places into "…", whose menu links them in order; with room again they come back.
