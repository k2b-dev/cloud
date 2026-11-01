### Draft size validation happened after rendering work

- **What happened:** A renderer limit regression spent its test budget parsing an input already larger than Mail's public draft body limit.
- **Root cause:** The internal renderer enforced output size but did not reject the oversized input before template, Markdown and CSS work.
- **Error class:** Performing expensive work before validating the owning application's input budget.
- **Guard:** `compose-renderer.test.ts` submits one character beyond the draft body limit and asserts rejection before Markdown rendering. Existing output-size and complexity cases retain their original limits.
