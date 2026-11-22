### The profile's expiry notice sat inset inside the page

- **What happened:** With the flat notice cell (PR2) the "Dein Konto läuft in … Tagen ab" notice on the profile was square and tinted, but it stood 24 px inside the page frame, and its text started 20 px right of the page's text edge.
- **Root cause:** The account page set its own 24 px padding, and the profile placed its notices inside that padding. The notice cell expects its host to place it from edge to edge of its column, with its padding on the text edge.
- **Error class:** A building block that changes from a framed box to an edge-to-edge cell while its host keeps placing it like a box.
- **Guard:** `account-pages.browser.test.ts` "the account expiry notice is a square cell from edge to edge of the page …" checks radius 0, both edges on the frame and the first text line on the first section heading's edge at 390 and 1440 px with classic scrollbars.
