### Try again did nothing while Send waited

- **What happened:** After a failed send, "Try again" in the toast closed the toast and did nothing when Send was held
  in the meantime, for example because the window went offline. A time picked for Send later was dropped the same way.
  In the reply box, a shared draft with a refused edit or a failure said "Send waits until … connected" as if waiting
  would help.
- **Root cause:** These paths reached Send after a delay and met the shared guard `sendHeld`, which returns without a
  word: right for a disabled button, wrong for a click that already happened. The reply box's wait reason treated every
  shared state that cannot send as "still connecting".
- **Error class:** A click whose action is refused later ends without a visible answer.
- **Guard:** `sendOrSayWhy` in `MailComposer.tsx`: a delayed send that meets a held Send names the reason in the toast
  and keeps Try again. A behavior test clicks Try again in an offline window and expects the offline reason and no send.
