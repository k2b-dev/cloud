### Clipboard normalization changed pasted source code

- **What happened:** Pasting code into the shared editor collapsed indentation or blank lines and could turn tabs into a table.
- **Root cause:** The prose converter ran before checking the destination syntax, then normalized whitespace across literal code blocks.
- **Error class:** Applying prose normalization to a literal-text context.
- **Guard:** `text-editor-paste.behavior.test.ts` covers fenced, indented and inline destinations, HTML-only code, editor clipboard line wrappers, and whitespace-preserving styles. Plain clipboard text takes precedence inside code; block conversion preserves literal whitespace.
