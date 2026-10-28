### A live Chat burst skipped unseen messages

- **What happened:** Returning to a chat after a hidden or unfocused burst could advance the read position over messages the person had not seen ([#1130](https://github.com/k2b-dev/cloud/issues/1130)).
- **Root cause:** A skipped range had no recovery control, while intermediate reconnect windows could incorrectly look like contiguous reading before catch-up completed.
- **Error class:** A visible message advances past an unseen gap.
- **Guard:** The read reporter retains the contiguous frontier and exposes a recoverable unread gap. Workspace behavior and browser tests require a jump back through the gap after hidden and unfocused bursts and reconnect replay, while keeping the fixed opening marker distinct. Only the caught-up, painted range begins new reading. Explicit reads clear the marker only after success and advance local progress without changing the live baseline; delayed live responses cannot recreate a cleared gap. Reporter and browser guards cover delayed replies, a rejected read and retry.
