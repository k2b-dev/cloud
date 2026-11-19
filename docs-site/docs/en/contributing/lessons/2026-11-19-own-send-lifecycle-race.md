### A shared draft's own send looked like someone else's

- **What happened:** After Send in a shared draft, the compose window filled with notices: the generation's "Draft
  sent" error with Try again and Copy, grey boxes saying the device has no changes beyond the sent draft, and a
  lifecycle box. A toast that the person themselves "started sending this message" came several times. The toast with
  Undo never came.
- **Root cause:** The server closes the draft's generation and tells every open copy live before the send command
  answers. The composer treated that close as a foreign lifecycle change: it aborted its own send command, so the
  answer with the Undo toast was dropped, and it showed every closed-draft notice. Its close effect also ran again on
  each later state change of the frozen draft and toasted each time.
- **Error class:** A live event caused by this client's own pending request handled as someone else's change.
- **Guard:** While its own send runs or has gone out, the composer keeps the command running and shows no lifecycle
  notice, hint, or toast; the close effect runs once. The behavior test "a shared draft sent from the large window
  closes once with one toast …" delivers the live close before the command answers and fails without the guard.
