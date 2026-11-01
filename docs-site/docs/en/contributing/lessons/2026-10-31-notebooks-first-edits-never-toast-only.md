### Words typed before a note connected could end up only in a toast

- **What happened:** When the first words typed into a note met a rewrite by someone else that the text diff could not settle within its time limit, the editor showed the other person's text and offered the typed words only in a toast with a copy button.
- **Root cause:** Edits made before the live document arrived lived only in the editor. They were carried onto the live text by a character diff with a timeout, and on a timeout the fallback kept the live text and handed the typed text to a notification.
- **Error class:** A merge fallback discards a person's input from the document and keeps it only in a transient message.
- **Guard:** Since the device input change, the first keystroke is already a Yjs update stored on the device, so a concurrent rewrite merges without a text diff. `sync-ended.behavior.test.tsx` ("first edits survive a remote rewrite whose text diff runs out of time") forces the diff to give up and checks that the typed words stay in the note.
