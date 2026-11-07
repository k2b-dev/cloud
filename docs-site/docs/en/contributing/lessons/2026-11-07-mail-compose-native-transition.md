### A Mail navigation test raced native document transitions

- **What happened:** The desktop compose-intent browser test failed with `InvalidStateError: Transition was aborted because of invalid state. ViewTransition opt-in disabled` while navigating back (#2780).
- **Root cause:** The fixture loads the production stylesheet, which opts documents into native view transitions. It navigated again before settling the previous transition, although the test checks preparation and history rather than animation.
- **Error class:** A navigation fixture leaves incidental motion enabled and reads layout or starts another navigation before the current document settles.
- **Guard:** Both viewport cases request reduced motion, assert that preference, and call `settled` before layout reads and around document navigations. The page-error assertion remains unchanged; no errors are filtered and no timeout is raised.
