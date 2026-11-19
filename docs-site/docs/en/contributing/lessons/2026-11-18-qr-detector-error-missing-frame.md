### The QR scanner test waited for a frame its fake camera never supplied

- **What happened:** The transient detector-error test timed out in WebKit CI with one detector call, an active camera, and no result (#3663).
- **Root cause:** The canvas camera repeatedly painted the same QR picture. In a local WebKit reproduction, 287 paints produced only one video-frame callback. The scanner had created its worker and requested the next frame, but that callback never arrived, so no decode request reached the worker. The detector error had not stopped the scanner.
- **Error class:** A media fixture supplies an unchanged picture while a test depends on a later video frame.
- **Guard:** The detector-error case in `packages/ui/src/inputs/qr-scanner.browser.test.ts` starts with the existing blank camera, waits for the first detector call, checks that the session has not stopped or failed, and then reveals the QR picture. Its changed frame lets the worker read the code; the assertions still require the result, no errors or stops, and exactly one native detector call.
