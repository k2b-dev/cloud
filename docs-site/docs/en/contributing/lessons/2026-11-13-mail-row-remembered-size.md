### Off-screen Mail rows kept their old height after a density switch

- **What happened:** In WebKit, when the Mail list switched from three lines to one, the rows above the view stayed 78 px high instead of 44 px. In both engines, a draft row in a wide Drafts folder grew from 44 px to 78 px after hydration.
- **Root cause:** The rows use `content-visibility: auto`. WebKit implies `contain-intrinsic-size: auto` for such rows, so a skipped row keeps the size it last rendered at, not the stand-in. The one-line stand-in was also set on the conversation list's scroller only, so the Drafts list always got the three-line stand-in.
- **Error class:** A skipped element's size comes from the browser's memory of an earlier frame, or from an ancestor that only some lists have, not from the current layout rule.
- **Guard:** Each `.mail-list-entry` sets its own fixed height for its density inside the `mail-list` container query. The WebKit shell cases `F2 by handle` and `F2 by window` and `compact draft queue` check the row heights after the switch and after hydration.
