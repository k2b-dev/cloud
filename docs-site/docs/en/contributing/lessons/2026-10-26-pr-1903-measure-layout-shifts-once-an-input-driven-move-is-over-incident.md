### Measure layout shifts once an input-driven move is over

- **What happened:** timing-dependent layout-shift assertion. Opening and closing Chat info moves the reading column on purpose. The browser excludes such a move only within 500 ms of the click, so on a busy machine the move counted as a shift and the test failed now and then. A second `observeShifts()` call also left the first observer adding to the same total.
- **Root cause:** The assertion observed intentional panel transitions outside the browser’s recent-input window, and an old observer kept reporting into the same total.
- **Error class:** timing-dependent layout-shift assertion
- **Guard:** the Chat info geometry test starts a fresh observer once the panel has entered or left, and `observeShifts()` disconnects the previous one. Everything that moves after that still fails the test.
