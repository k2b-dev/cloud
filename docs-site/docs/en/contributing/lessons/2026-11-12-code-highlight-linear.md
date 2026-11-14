### Code highlighting slowed down on long repetitive input

- **What happened:** Markdown code highlighting took seconds on long repetitive directive names, whitespace, and fence languages.
- **Root cause:** Greedy prefix matches shared characters with later captures. When a later line terminator prevented a complete match, the expressions retried shorter prefixes and rescanned the remaining text.
- **Error class:** Regular expressions with overlapping quantifiers on unbounded text.
- **Guard:** `packages/ui/src/content/code-highlight.test.ts` checks four 75,000-character repetitive inputs against a generous 1,000 ms bound and asserts exact output for ordinary Markdown. The existing CodeQL check also detects this error class.
