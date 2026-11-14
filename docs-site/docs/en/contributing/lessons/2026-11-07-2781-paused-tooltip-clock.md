### Advance a paused browser clock for delayed keyboard feedback

- **What happened:** Pulse’s area and money panel browser tests reached the Budget row but timed out waiting for its keyboard tooltip in Chromium and WebKit.
- **Root cause:** The fixture pauses both Date and browser timers. Chart inspection opens immediately, while the shared Budget tooltip schedules its normal 250 ms focus delay. Waiting in real time cannot run that paused timer.
- **Error class:** A test waits for timer-driven feedback without advancing its controlled clock.
- **Guard:** The Pulse dashboard browser test focuses the Budget row, checks that its delayed tooltip is still closed, advances the browser clock through the delay, then requires the visible tooltip to name that row. Existing frame, recovery and keyboard assertions and the 30 s timeout stay unchanged.
