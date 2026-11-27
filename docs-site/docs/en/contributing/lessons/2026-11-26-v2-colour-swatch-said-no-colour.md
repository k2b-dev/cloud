### The swatch of a v2 colour field did not say its colour

- **What happened:** In the review of #4191, the swatch of `ColorInput`, the button that opens area and hue, was named "Farbe wählen" and nothing more. A screen reader on the swatch did not hear which colour the field holds; only the code input beside it said so.
- **Root cause:** The swatch drew the colour with an `aria-hidden` fill and had no description. The code input had an id only inside a `Field`.
- **Error class:** A control whose state shows only as colour or shape, with a name that says its deed but nothing of that state.
- **Guard:** The swatch keeps its deed as its name and is described by the code input (`aria-describedby`), which has an id also without a `Field`. `packages/ui/src/v2/form-controls.browser.test.ts` checks that the swatch's description points at the code, in Chromium and WebKit. The disclosure test there now also checks the padding its title promises.
