### A loading list disappearing was mistaken for completed map recovery

- **What happened:** WebKit sometimes read `GEO_ADDRESS_AMBIGUOUS` with `requiresCostConfirmation` after the candidate list disappeared in the map recovery test (#3315).
- **Root cause:** Starting the action sets `busy`, so `MapDialog` replaces its list with a loading skeleton before the action finishes. The service clears the issue on a cloned map and the browser receives the completed snapshot together; the disappearing list never signalled completion. Holding the action request reproduced the original failure in WebKit without a timer.
- **Error class:** A browser test mistakes an intermediate loading transition for a completed domain change.
- **Guard:** The recovery test registers its response wait before clicking and waits for the action snapshot with no issue before reading stored state. The held-request experiment failed with the original assertion and passed with this completion signal; `test-waits` and `browser-test-promises` guard against fixed waits and unjoined browser promises.
