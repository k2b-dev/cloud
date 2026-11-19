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
  notice, hint, or toast, unless the comparison with the sent draft fails; the close effect runs once. An own send whose
  answer got lost after the close leaves with the delivery toast. The behavior tests around "a shared draft sent from
  the large window …" deliver the live close before the command answers: success, a lost answer, a peer who sent
  first, and a failed comparison with input typed during the send.
