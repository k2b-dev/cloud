### A section's deed lost its name on the phone

- **What happened:** On the phone, the deeds in a v2 `Section` head (Notebooks, W2) showed only their symbol, and assistive technology announced them as unnamed buttons. A deed without a symbol showed nothing at all.
- **Root cause:** The phone rule that keeps only the symbol hid the button's words with `display: none`. The words were the button's only name, and the rule applied to deeds with and without a symbol alike.
- **Error class:** Hiding text with `display: none` also takes it out of the accessibility tree, so a control whose name is its visible words loses that name.
- **Guard:** The rule now hides the words visually only (clipped to 1 px) and only on a deed that has a symbol. `packages/ui/src/v2/section-actions.browser.test.ts` checks at 390 and 1440 px, in Chromium and WebKit, that both deeds are found by their names and that a deed without a symbol keeps its words in sight.
