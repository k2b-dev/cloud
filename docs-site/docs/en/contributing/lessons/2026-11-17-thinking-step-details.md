### Thinking steps need their own public presentation

- **What happened:** A thinking step's details displayed the model's raw English text and technical identifiers.
- **Root cause:** Public message and live-block projections reused provider thinking content as step details.
- **Error class:** Internal model content reused as user-facing presentation.
- **Guard:** `public-projection.test.ts`, `thinking-details.render.test.tsx`, the thinking-details browser test, and the conversation read-API regression verify that thinking content never becomes public step details; locale tests keep the available duration in the reader's language.
