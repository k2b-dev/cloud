### A slow WebKit runner looked like hanging recovery tests

- **What happened:** The gate of #3518 failed `webkit (17)` with 14 App-PWA Kiosk tests, among them the "Additional recovery" block, at exactly 5 s, one Gustav navigation, and the Places and Maps suite at its 180 s limit. #3518 only changed Core texts, and the same shard on #3510 passed.
- **Root cause:** The runner of that job was about five times slower before any test ran: `bun install` took 20 s instead of 3 to 8 s, and every warm-up scene took 4.4 to 5.4 s instead of 0.8 to 1.6 s. No wait hung; each Kiosk test took five times its usual 0.5 to 1.3 s, and the longer ones crossed 5 s.
- **Error class:** A degraded CI runner whose slowdown is reported as unrelated test timeouts.
- **Guard:** The browser warm-up stops the run with "Browser runner too slow" when its fastest warm scene takes half of a test's 5 s (`packages/ui/scripts/browser-warmup-speed.test.ts`).
