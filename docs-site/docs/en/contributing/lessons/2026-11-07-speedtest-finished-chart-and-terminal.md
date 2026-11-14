### Finished speedtests need their own chart bounds

- **What happened:** A test that finished early left its history on the full mode time axis. The completed progress bar added no information, and wrapping terminal lines hid the final message on phones.
- **Root cause:** Running presentation rules also applied to completed results, while a fixed terminal height assumed single-line output without enforcing it. Exact chart bounds also retained round ticks immediately beside endpoint labels.
- **Error class:** Stale result presentation and clipped diagnostic output.
- **Guard:** The browser flow checks that the running axis stays fixed and the result axis ends at the reported duration. It also checks unchanged outer geometry, a hidden completed progress bar, and complete unwrapped terminal output with horizontal scrolling on phones. Shared chart guards cover positive and negative exact bounds on both axes, keeping at least half a regular interval between an endpoint and its next tick.
