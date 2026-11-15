### A stopped turn showed two endings

- **What happened:** In the second Preview tour, a turn the person stopped ended with the quiet line "Du hast gestoppt · Neu antworten" and below it the yellow notice "Die Antwort wurde abgebrochen · Weiterschreiben".
- **Root cause:** The line followed the turn's phase, the notice the message's stop reason; both read "stopped" from the same turn, and nothing said who stopped it.
- **Error class:** Two views derive the same state from different fields of one turn and each renders its own ending.
- **Guard:** `stoppedByPerson()` in `stop-notice.ts` names the person's stop (the loop ended as aborted); the chat shows the line only then and leaves the notice to turns Cloud ended. `stop-notice.test.ts` pins the signal, the gallery browser test pins one ending.
