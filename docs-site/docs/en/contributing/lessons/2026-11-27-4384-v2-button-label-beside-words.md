### A v2 button with words did not use its label as its name

- **What happened:** Notebooks (the book screen) gave a v2 `Button` both words ("Öffnen") and a `label` that said more ("Öffnen: Hausordnung"). Assistive technology heard only "Öffnen". The type and its documentation said that `label` is the name where the words alone do not say enough.
- **Root cause:** `Button` set `aria-label` only for an icon button. Beside words, the type accepted `label`, but the button did not use it.
- **Error class:** A prop the type accepts and documents but the component does not use. Type checks and a look at the screen cannot find it; only the accessibility tree shows it.
- **Guard:** `Button` sets `aria-label` from `label` in every case. `packages/ui/src/v2/button-name.browser.test.ts` reads the server markup and the accessibility tree in Chromium and WebKit. It checks four cases: words with a label, words alone, an icon button, and words with `about`. In each case the name and the hint under the pointer must be as documented.
- **Known limits:** Nothing checks that a label begins with the button's words (WCAG 2.5.3). The documentation asks for it.
