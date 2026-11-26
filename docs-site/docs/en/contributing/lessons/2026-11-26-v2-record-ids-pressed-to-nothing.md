### A record head pressed its identifiers to nothing

- **What happened:** In Grids, a record with a long name and three identifiers showed its identifiers as boxes of 0 px at 1024 px, and the layout check reported that their text was gone. The app hid the identifiers to stay clean.
- **Root cause:** `RecordHead` let each identifier shrink first (`flex: 0 100 auto; min-width: 0`), so where the head had no room they shrank until nothing of them was left, instead of leaving whole.
- **Error class:** A part that should give way shrinks to nothing instead of leaving whole; a part that is out of sight must still be reachable.
- **Guard:** The identifiers stand in one line that hides what wraps (as a `StatusRow`'s key figures). The ones without room wrap out of sight below it, whole and the last first. The name says them on hover, and they stay in the page for assistive technology. `packages/ui/src/v2/record-head.browser.test.ts` checks at 1024 and 390 px, in Chromium and WebKit, with a long name and three identifiers:
  - each identifier is whole or out of sight, and on the phone all are out of sight;
  - the head's deeds stay in their row;
  - the name's hint holds the identifiers;
  - `measureV2Layout` reports nothing squeezed.
