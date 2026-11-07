### Assistant turn fails without telling the person

- **What happened:** When the model provider rejected a request in the middle of a turn, the chat showed the last progress sentence and then nothing ([#1150](https://github.com/k2b-dev/cloud/issues/1150)).
- **Root cause:** Suspected: the failed-turn notice from [#712](https://github.com/k2b-dev/cloud/pull/712) does not show on this path. The turn outcome records the provider error, but the chat ends on the last progress sentence; the exact path is open in [#1150](https://github.com/k2b-dev/cloud/issues/1150).
- **Error class:** Silent failure.
- **Guard:** Pending in [#1150](https://github.com/k2b-dev/cloud/issues/1150): a failed turn always ends with one line that says what failed and offers a retry.
