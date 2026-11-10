### A fixed wait as long as the toast motion read the stack mid-move in WebKit

- **What happened:** The MobileShell test for the room a persistent toast takes failed in WebKit in the merge queue for an unrelated pull request: the reserved inset was 0.5 px off the toast's top (#3121).
- **Root cause:** The test waited a fixed 400 ms after showing a toast and then read the geometry. A toast opens a frame after it is added, then moves for the stack's motion time of 400 ms, and the shell measures the room it takes in the frame after that motion ends. On a slow runner the test read the stack before the shell's last measurement. The inset is the same float the test computes from the same rectangles, so the difference was not rounding.
- **Error class:** A fixed wait that equals an animation's duration, so the read lands at the end of the motion and depends on runner speed.
- **Guard:** The MobileShell toast tests wait with `toastsSettled()` until no toast is entering and `settled()` finds no running animation. A rule for short fixed browser waits elsewhere is pending in #3122; `test-waits` flags fixed waits only from one second on.
