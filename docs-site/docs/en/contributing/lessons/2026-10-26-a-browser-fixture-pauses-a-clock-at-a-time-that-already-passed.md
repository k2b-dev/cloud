### A browser fixture pauses a clock at a time that already passed

- **What happened:** Installing a running clock and pausing at its initial timestamp races browser command latency; a busy host reports “Cannot fast-forward to the past”.
- **Root cause:** The fixture installed a running clock and tried to pause it at the timestamp used during installation.
- **Error class:** A browser fixture pauses a clock at a time that already passed
- **Guard:** Test: Pulse `WorkspaceClock.browser.test.ts` advances the clock before pausing, then verifies the exact fixture time across navigation and subsequent timer advancement. Freeze wall time before pausing and restore normal clock advancement while paused.
