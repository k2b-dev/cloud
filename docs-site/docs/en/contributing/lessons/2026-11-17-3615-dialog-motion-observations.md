### Dialog assertions sample the state they claim to check

- **What happened:** After dialogs gained entrance and exit motion, Code's unchanged-layout assertion sampled the entrance offset, and its scanner test read an unset close observation.
- **Root cause:** The first button measurement preceded the end of the entrance transition. The scanner observer waited for frame removal, while the role locator stopped matching as soon as closing hid the retained frame from the accessibility tree. The scanner already wrote its result before closing.
- **Error class:** Browser assertions confuse transition frames, logical closure, and DOM removal.
- **Guard:** `CodeArea.browser.test.ts` waits with the shared `settled` helper before comparing exact button bounds. `page.browser.test.ts` observes the scanner's `open` attribute and asserts that the field already holds the scan at logical closure, before exit disposal.
