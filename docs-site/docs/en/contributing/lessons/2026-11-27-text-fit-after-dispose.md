### A text field measured itself after it had left the page

- **What happened:** A gateway-ops behavior test that rendered a v2 form with a text of several lines failed with `document is not defined`. The failure came after the test had already disposed the form and removed its test DOM.
- **Root cause:** Where the browser has no CSS `field-sizing`, `followText` in `packages/ui/src/v2/controls.tsx` fits the field's height in a microtask after the value changes. The microtask also ran after the field was disposed, and then it read `document.scrollingElement`. In a browser that only measures a detached field; in a test DOM that is gone, it throws.
- **Error class:** Work queued by a component (microtask, timer, frame) that runs after the component's cleanup.
- **Guard:** `fit` returns when the field is disposed or no longer in the document. The test "a text of several lines that leaves before its height is fitted is not measured any more" in `packages/ui/test/v2-text-fit.behavior.test.tsx` fails without the guard and passes with it.
