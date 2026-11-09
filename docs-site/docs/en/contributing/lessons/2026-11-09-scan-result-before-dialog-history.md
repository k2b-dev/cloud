### Write a dialog's outcome when it happens, not when its history entry is gone

- **What happened:** In a WebKit sync gate, the Code page scan field still showed its old value (`W-1`) after the scanner dialog had closed. The test expected the scanned `W-42`.
- **Root cause:** `CodeField` wrote the scan only after `await dialogCore.open(...)`. With `history: true` that promise settles once the synthetic Back has removed the dialog's history entry, after the dialog has already left the page. For that moment (about 40 ms in Chromium, longer under load) the field showed the old value; the test usually read it a little later.
- **Error class:** UI state that depends on a dialog's outcome waits for the dialog's history cleanup instead of the moment of the outcome.
- **Guard:** `CodeField` applies the scan result or camera error in the scanner's own callbacks before it closes the dialog; only the focus waits for the closed dialog. The Code page browser test records the field's value when the dialog leaves the DOM and expects the scan there. It fails without the fix in Chromium and WebKit.
