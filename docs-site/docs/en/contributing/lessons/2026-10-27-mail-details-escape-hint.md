### A test's Escape closed a hint instead of the Details column

- **What happened:** In WebKit CI, "persistent Details: default, close, resize and reload at 1920" expected the Details toggle to report `aria-expanded="false"` after Escape and read `"true"` (run 40533200164). It blocked #1983, #1980 and #1969.
- **Root cause:** The test clicked the Details toggle twice and left the pointer there. After the resize from 1920 to 1900 px, the pointer rested on the column's "Close details" button, whose hint opened 250 ms later. With a hint open, the first Escape dismisses the hint, as it should, and the column stays open. A recorded keydown showed Escape with `defaultPrevented` and an open "Close details" tooltip; the column was still open 1.5 s later.
- **Error class:** A keyboard step in a browser test runs while the resting pointer has opened a hint that takes the key first. Whether that happens depends on layout and timing.
- **Guard:** `pressEscapeForWorkspace` in `mail-shell.browser-suite.ts` moves the pointer to the empty shell rail and waits until no tooltip is open before it presses Escape. The persistent Details cases use it for every Escape that should reach the workspace.
