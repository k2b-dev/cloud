### Send on an untouched Code suggestion did nothing

- **What happened:** In the reply box above a conversation, a click on Send on an untouched Code suggestion sent
  nothing and said nothing (#3859). After the person typed into the text, Send worked. The quote of a Code reply also
  said "… wrote:" in a German mailbox (#3860).
- **Root cause:** The box keeps a reserved height until someone works in it and grew to its content on `pointerdown`.
  A suggestion cut off at that height grew on the press, Send moved about 120 px down, and the release landed
  elsewhere, so the browser fired no click. Typing first grew the box, which is why Send worked afterwards. The quote
  language came from the Code run, which has no person locale, and nothing gave it to the person who sends.
- **Error class:** A control moves on the press that activates it, so its click never arrives and the action fails
  without a word.
- **Guard:** The box grows only after a press ends, and never from a press on its action bar. A browser test presses
  Send on a cut-off suggestion, expects Send not to move, and expects the send. `mail-composer-send-entries.test.ts`
  allows `sendDraft` only from Send buttons that `sendHeld` disables; every other way in uses `sendOrSayWhy`. A
  reply-box behavior test sends a Code suggestion in German and expects the German quote locale.
