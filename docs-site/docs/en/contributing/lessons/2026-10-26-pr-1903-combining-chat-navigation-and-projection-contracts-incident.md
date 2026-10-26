### Combining chat navigation and projection contracts

- **What happened:** After merging chat features, a system-chat fixture lacked required channel fields, overview links escaped the panel, and a polling helper mixed wall and monotonic clocks.
- **Root cause:** Existing fixtures and newly added links still followed the older view contract; the resolved polling loop combined timestamps from different clocks.
- **Error class:** Independent feature slices leave incompatible projection, navigation, or timing assumptions at their intersection.
- **Guard:** System-chat unit fixtures include channel state. The system-chat browser suite checks item, overview, back, and info links inside the panel. Polling deadlines and comparisons use the same clock.
