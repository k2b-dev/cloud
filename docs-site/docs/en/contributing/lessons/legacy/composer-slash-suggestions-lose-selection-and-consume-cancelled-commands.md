### Composer slash suggestions lose selection and consume cancelled commands

- **What happened:** Typing emptied server suggestions, result updates reset arrow selection, and cancelled actions consumed their slash token. Unavailable rows had no explanation.
- **Root cause:** Search cleared rows before each request, selection and option ids used array positions, and only rejections restored the draft.
- **Error class:** Layout shift; state lost on navigation or reload.
- **Guard:** `chat-slash.behavior.test.ts` covers retained results, stable keyed selection, reasons, keyboard modifiers, Escape, guarded restoration, and status outcomes, including that a command failure stays visible until the next edit, command, or draft switch and reaches `onError` after an unmount. `chat-composer.browser.test.ts` checks list and status layout at desktop and phone widths.
