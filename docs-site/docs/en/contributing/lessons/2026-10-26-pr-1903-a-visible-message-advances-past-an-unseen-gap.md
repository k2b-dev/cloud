### A visible message advances past an unseen gap

- **What happened:** A virtualized live feed reports its newest visible sequence as read after a hidden or unfocused burst, skipping unseen messages ([#1130](https://github.com/k2b-dev/cloud/issues/1130)).
- **Root cause:** A visible message advances past an unseen gap.
- **Error class:** A visible message advances past an unseen gap
- **Guard:** Tests: Chat `read-reporter.test.ts` preserves a contiguous frontier; workspace behavior and browser tests cover hidden and unfocused bursts, reconnect replay, visible gap recovery and the separate fixed opening marker. Reading waits for catch-up and a painted visible range.
