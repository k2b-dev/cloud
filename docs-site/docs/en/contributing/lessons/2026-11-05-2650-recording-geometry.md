### Settle the recording fixture before measuring the composer

- **What happened:** The recording follow-up failed the repository check on its initial composer geometry read.
- **Root cause:** The new recording case filled the field and measured its box before the browser finished the resulting layout.
- **Error class:** Geometry sampled between an input event and stable layout.
- **Guard:** The `settle-reads` check and the recording cases in `AssistantPwa.more.browser.test.ts`.
