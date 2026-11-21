### A folder-loading fixture blocked the root needed to open that folder

- **What happened:** The file chooser's grid geometry test timed out in WebKit while waiting for the Home row; the other chooser cases passed.
- **Root cause:** The test armed `listGate` after clicking Drive but before its root listing had necessarily reached the fixture. The fixture awaited that gate for every folder listing, including the root that supplies Home. The test could only release the gate after clicking Home, so neither side could continue. Delaying the root request until after the click in Chromium reproduced the missing row; releasing the fixture gate made Home appear.
- **Error class:** An asynchronous fixture blocks a prerequisite before the test observes it ready.
- **Guard:** The grid geometry test waits for the root list to leave `aria-busy` and asserts its entries before arming the folder-loading gate. Its strict empty-state, row, toolbar, preview, and button geometry assertions remain unchanged. Follow **Wait for conditions, not time** in the testing guide: a completed click does not imply a completed listing.
