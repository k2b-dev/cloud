### Chat typography changed when the active step changed

- **What happened:** Intermediate text became smaller and grey when the next step started, while thinking and writing labels used different shimmer colours.
- **Root cause:** Cloud's `ai-turn__text--status` rules replaced answer typography with a smaller muted style, and its work-line shimmer used different text tokens for thinking words and ordinary labels.
- **Error class:** State-dependent typography in a persistent progress region.
- **Guard:** `packages/cloud/src/ai/chat/live-turn.browser.test.ts` compares computed font size, line height, colour, and geometry across live phases and saved history in both themes and at desktop and phone widths.
