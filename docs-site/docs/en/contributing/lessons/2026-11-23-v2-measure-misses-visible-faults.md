### The v2 layout measure passed screens with faults a person saw at once

- **What happened:** The Mail pilot on v2 passed `measureV2Layout`, yet the maintainer saw double lines in it. Agent tests showed button labels cut by their own button, and row lines that wrapped where they should end with "…". The measure reported none of them.
- **Root cause:** `packages/ui/src/v2/testing/measure-v2-layout.ts` skipped a `Canvas` together with its own border. Its double-line rule only looked at lines at most 1 px apart, so a line between two parts of one band, 12 px from the next line, passed. Nothing compared a control's label with the room of the control, or a one-line text with its height.
- **Error class:** A layout measurement that only knows the faults it was written for, so a screen passes while a person sees a fault of another kind.
- **Guard:**
  - The measure now reports a line inside a band or group at any distance (`inside`). It also reports a control that cuts its label and a one-line text that wraps (`cut`). A canvas's own line counts again.
  - `measure-v2-layout.browser.test.ts` holds a red and a green page for each of them, also built from v2's own band, canvas and three-line row. `describeV2` names the cut texts as well.
  - Three primitives break these rules today. Each is allowed as one named finding until it is fixed: the selecting status row at 390 px (#4073), a canvas in a band that draws its own line (#4074), and the title of a three-line row that wraps (#4075).
