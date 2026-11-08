### Underline a link that sits in running text

- **What happened:** The stale note of a dashboard frame ("Data from 09:12 · Try again") showed Try again in the same color and weight as the sentence around it. It worked by keyboard and pointer, but nothing marked it as something to press.
- **Root cause:** The button reset its native look to fit into the line (`color: inherit`, no padding) and dropped the underline that every other link in running text has.
- **Error class:** An inline control that resets its look to blend into a sentence also loses its only visible affordance.
- **Guard:** `packages/ui/src/widgets/dashboard-frame.browser.test.ts` waits for the focused stale link's `text-decoration-line: underline` with the base stylesheet loaded.
