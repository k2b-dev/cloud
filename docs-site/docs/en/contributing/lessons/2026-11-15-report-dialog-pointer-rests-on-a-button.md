### A pointer left on a button made the report dialog test see a running hover in WebKit

- **What happened:** The Code page browser test "reporting: one optional reason … the card says Reported" failed in WebKit: `settled` reported a `background-color` transition on a hovered `button.k2b-button` right after the report dialog opened.
- **Root cause:** The test clicked "Seite melden", and the pointer stayed where it clicked. The dialog then opened with a button under that resting pointer, whose hover transition could start while `settled` waited. Whether it did depended on timing and on the engine.
- **Error class:** A test leaves the pointer where it last clicked, and content that later moves under it starts hover animations the test did not ask for.
- **Guard:** `packages/core/src/code/page.browser.test.ts` waits for the dialog's own status line and moves the pointer to a neutral corner (`restPointer`) before each `settled` in the report test. `settled` already reports `"hovered"` targets.
