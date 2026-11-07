### The upload list stopped following after the pointer left

- **What happened:** The WebKit test for the upload list failed in the merge queue: after the pointer left the list, the list stayed on the old row instead of following the file in flight ([#1371](https://github.com/k2b-dev/cloud/issues/1371)).
- **Root cause:** The pointer rested on the byte count of the file in flight. When the file finished, its row dropped that line. WebKit sends no `pointerleave` when the hovered element leaves the document, unless a later hover update finds a new element under the pointer first. Without the leave, the list kept waiting for the pointer, and a finished panel did not leave after five seconds. The same happens in Safari during a real upload. The follow itself is immediate with reduced motion, so a longer wait in the test would not have helped.
- **Error class:** Hover kept after its element left.
- **Guard:** The panel confirms both hover states with the next `pointerover` on the document. `UploadPanel.browser.test.ts` moves the pointer away right after the byte count leaves, which failed 10 of 10 runs in WebKit without the fix, and checks both the follow and the five-second leave.
