### A sheet's detent changed before the sheet came to rest

- **What happened:** After #3360 a sheet with a handle sets `data-sheet-detent` when a move starts and glides there by transform. The map dialog's phone test read the handle's box right after waiting for the attribute, while the list still glided, and its hit test landed on the map instead of the handle (#3335, CI only). In the product, the map dialog sets the detent itself when a place is picked; a glide still in flight then landed on the old height and jumped to the new one.
- **Root cause:** The attribute became the sheet's goal, not its resting state, but tests and owners still treated it as the rest. `attachSheetHandle` ignored detent changes it had not made itself while it moved.
- **Error class:** State that announces a motion's target read as if the motion had ended, by a test or by a second writer of the same attribute.
- **Guard:** `sheet-handle.browser.test.ts` pins an owner that sets the detent mid-glide (the sheet turns around without a jump); browser tests read geometry only after `settled(page)` (rule `settle-reads`), and the map dialog test now does before its hit test.
