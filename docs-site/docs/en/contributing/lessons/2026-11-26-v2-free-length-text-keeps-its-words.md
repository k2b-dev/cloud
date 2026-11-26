### v2 primitives cut or boxed text of free length

- **What happened:** The FAQ lane (#4172) needed three `// k2b-ui gap:` workarounds. A long `Section` title, such as a question, stayed on one line and ran out of its head. `Check` had no line for what turning it on does. A multi-line `Input` was a fixed 80 px, so a long answer scrolled inside a small box.
- **Root cause:** The section head had a fixed height, and its title did not wrap (`white-space: nowrap`). `Check` offered only `label`. The multi-line field had a fixed height and did not size to its text.
- **Error class:** A v2 primitive that gives text of free length (titles, answers, explanations) a fixed size: the text is cut, overlaps, or scrolls in a box that is too small.
- **Guard:** `packages/ui/src/v2/text-shapes.browser.test.ts` in Chromium and WebKit: a long section title wraps whole while a short head keeps 52 px, a check's description stands under its words and describes the box, and a multi-line field shows its rows and grows line by line up to ten lines before it scrolls.
