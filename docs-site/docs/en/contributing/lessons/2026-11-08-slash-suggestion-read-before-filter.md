### A Notebooks slash test read the suggestion list before the query had filtered it

- **What happened:** `approved WAVE1 slash-de opens the shared size picker on phone` failed in the merge queue for unrelated pull requests (#2666, again for #2896): the editor already held `/tabelle`, but the first suggestion was still "Map", the first entry of the unfiltered slash list.
- **Root cause:** The test read the first `.cm-tooltip-autocomplete` option as soon as the tooltip existed. CodeMirror opens the tooltip for `/` and applies the typed query one update later, so a slower runner saw the unfiltered list.
- **Error class:** A browser test reads state that a UI transition updates asynchronously, right after an action, instead of waiting for the condition it asserts.
- **Guard:** The test waits with `page.waitForFunction` until the first option is the filtered "Table" entry, within the same 1 s, and then asserts it. Same convention as [the Mail menu lesson](2026-11-07-mail-row-menu-state-read-before-close.md); class, text and attribute reads are too common to flag statically.
