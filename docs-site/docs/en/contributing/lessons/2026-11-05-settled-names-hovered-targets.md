### A settled() failure hid that hover started the animation

- **What happened:** After the phone system-chat tests failed in CI (#2656), the reported `background-color` and `color` transitions on `a.k2b-button.k2b-icon-button` were first read as a button state that changed after mount, such as `aria-current` or a late theme value.
- **Root cause:** The error named only targets, properties and times. The real trigger was `:hover`: Playwright's pointer rests at the top left of every new page, touch contexts included, and the deferred threads page put its back button there after the workspace mounted. An instrumented local run saw the fade on 30 of 30 fresh loads; #2661 moved the suite to reduced motion.
- **Error class:** A test helper's failure message omits the state that started the animation, so the investigation chases the wrong cause.
- **Guard:** `settled()` marks each reported target with `"hovered"`, and its documentation names the resting pointer; a `@k2b/ui` browser test requires `"hovered":true` for an animating target under the pointer and `false` for one beside it.
