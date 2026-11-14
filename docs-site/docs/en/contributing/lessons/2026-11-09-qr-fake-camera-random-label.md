### A fake camera's random label made the QR scanner mirror the rear camera now and then

- **What happened:** The QR scanner browser test for iPhone failed in CI because the rear camera showed mirrored, on a pull request that did not touch the scanner (#3051).
- **Root cause:** The test films with `canvas.captureStream()`. Its track reports no facing, so the scanner reads the facing from the label, and Chromium gives a canvas track a random base64 label. A label that contained "user" or "face" counted as a front camera.
- **Error class:** A test double that carries random browser data into code that reads meaning from it, so the test fails about once in thousands of runs.
- **Guard:** The fake camera's track has a fixed empty label in `packages/ui/src/inputs/qr-scanner.browser.test.ts`; a label of "user" there fails the iPhone test every run.
