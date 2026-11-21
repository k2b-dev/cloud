### Mod+Enter sent what the disabled Send held back

- **What happened:** In a compose window, Mod+Enter could send while an attachment from the conversation was still
  arriving, or while the window was offline. The Send button was disabled in both cases.
- **Root cause:** The button and the shortcut each had their own copy of the "Send waits" condition: the window's
  button checked `attaching()` and offline, but `sendDraft` and `schedule` in `MailComposer.tsx` did not.
- **Error class:** Copies of one guard drifted between the control and its keyboard shortcut.
- **Guard:** One `sendHeld` answers for every Send button, Send later, and Mod+Enter. A behavior test presses Mod+Enter
  in an offline window and expects nothing to be sent.
