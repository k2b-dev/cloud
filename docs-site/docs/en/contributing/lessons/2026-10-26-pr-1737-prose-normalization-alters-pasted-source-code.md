### Prose normalization alters pasted source code

- **What happened:** Converting a code clipboard as prose collapses indentation or blank lines and can interpret tabs as table separators.
- **Root cause:** Prose normalization alters pasted source code.
- **Error class:** Prose normalization alters pasted source code
- **Guard:** Test: UI `text-editor-paste.behavior.test.ts` covers plain and HTML-only source, line wrappers, whitespace-preserving styles, and fenced, indented and inline code destinations.
