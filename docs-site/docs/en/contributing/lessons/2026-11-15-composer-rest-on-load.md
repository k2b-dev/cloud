### The assistant composer rests until someone asks for the field

- **What happened:** In the Gustav preview the composer always showed its focus look (full plum edge with glow), the suggestion hint stood inside the text line and large on phones, the "Kein Modell" label faded to about a quarter, and a greyed microphone stood where no dictation was set up.
- **Root cause:** Gustav passed `focusToken={0}`, which counts as a request, so `Chat.Composer` focused itself on every page load; the hint was an inline element; the no-model chip was a disabled button inside a disabled composer, so two opacities multiplied; the dictation control showed whenever live dictation was missing, even without an audio model.
- **Error class:** A state that is not the person's (a load, a missing setup) borrowing the look of an interaction state, and an explanation rendered as a faded control.
- **Guard:** `chat-composer-suggestion.browser.test.ts` (hint on its own line under the text, 12 px, 44 px touch area) and `model-chooser.browser.test.ts` (no-model label at full opacity, nothing opens).
