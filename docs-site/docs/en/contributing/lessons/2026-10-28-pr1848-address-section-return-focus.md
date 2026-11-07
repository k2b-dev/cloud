### Return from an editor to a visible address action

- **What happened:** Combining the collapsed Contacts address section with the focused address editor would return keyboard focus to a hidden Edit button.
- **Root cause:** Replacing the detail panel with the editor discarded the section's open state; the return path tried to focus the address action without opening its section.
- **Error class:** Returning focus without restoring the destination's visible state.
- **Guard:** Contacts `ContactAddressGeo.browser.test.ts` covers history navigation, editor reload and cancellation, and saving a tablet deep link. The section retains its collapsed initial state and opens when returning from its editor.
