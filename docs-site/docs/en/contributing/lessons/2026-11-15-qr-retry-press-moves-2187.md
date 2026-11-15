### A press on "Try again" reached the camera preview instead

- **What happened:** The QrScanner test "offers to start the camera picture again when the browser refuses to play it" timed out in WebKit CI runs: after the click, the preview stayed paused and no code was read.
- **Root cause:** The test page had no stylesheet, so the preview video was 300 × 150 until its first frame and then grew to 640 × 640. A refused `play()` shows "Try again" before that frame, and on a busy runner the picture arrived during Playwright's click, moving the button by 490 px. Playwright checks only the first pointer event of a click, so the click resolved while the press reached the video and `retry()` never ran. Cloud's stylesheet keeps the preview square, so the button does not move there.
- **Error class:** Pressing a control that moves while it is pressed, because the test lays the page out differently from the product.
- **Guard:** The QrScanner retry cases load the shipped stylesheet and check that "Try again" is still where it appeared once the picture has its size; the testing guide describes the class next to #2487.
