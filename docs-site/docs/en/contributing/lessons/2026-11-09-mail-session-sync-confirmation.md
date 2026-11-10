### Draft recovery must follow committed state across session transitions

- **What happened:** Closing during a save left later typing at an old revision. A peer update erased a rejected proposal, retry unlocked a stopped provider, a silent socket left sending waiting, and storage labels and journals outlived their confirmation or account.
- **Root cause:** UI lifetime controlled revision advancement; rejected proposals shared the ordinary projection lifecycle; resume returned no outcome; synchronization had no deadline; device and server confirmation were conflated; local journals had no expiry or account-switch fence.
- **Error class:** Unconfirmed local state discarded or presented as durable across asynchronous lifecycle transitions.
- **Guard:** Revision-enforcing close behavior, rejected-proposal reload, real provider backpressure retry, silent-socket timeout, debounce/echo/offline save-status, and journal expiry/account-switch tests in Mail, plus the shared provider reconnect test.
