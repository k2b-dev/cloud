### Keep list geometry and clocks independent of animation scheduling

- **What happened:** The extended Assistant part inherited rule failures and added geometry reads without settlement and a Playwright fake clock.
- **Root cause:** The list fixture measured its row before layout settled and replaced browser timers to pin displayed dates.
- **Error class:** Browser fixtures conflate date fixtures with layout and timer behavior.
- **Guard:** The `settle-reads`, `test-clock`, and `help-writing` checks, plus `AssistantPwa.more.browser.test.ts`.
