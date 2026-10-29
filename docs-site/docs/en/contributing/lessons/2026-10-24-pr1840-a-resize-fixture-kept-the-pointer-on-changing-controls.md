### A resize fixture kept the pointer on changing controls

- **What happened:** The Studio permissions WebKit case reached its geometry checks while button color transitions were starting.
- **Root cause:** Cancel removed the button under the pointer, then the fixture immediately resized the page. Hover changes could start transitions after the generic settle had collected the running animations.
- **Error class:** State sampled before it settled.
- **Guard:** `machine-permissions.browser.test.ts` waits for the secret form to close, parks the pointer on its persistent heading after each resize, and waits for button hover-color transitions before retaining the existing settle and geometry assertions.
