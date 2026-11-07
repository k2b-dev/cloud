### Check compact stylesheet rules for embedding scope

- **What happened:** Compact waterfall rules escaped the UI embedding scope check.

- **Root cause:** The check inspected only lines ending with an opening brace. Rules with declarations on the same line were skipped.

- **Error class:** Incomplete syntax coverage in a source guard allowed global component styles.

- **Guard:** `scripts/checks/css.test.ts` covers compact, adjacent, multiline and nested selectors, while permitting scoped selectors and keyframe steps.
