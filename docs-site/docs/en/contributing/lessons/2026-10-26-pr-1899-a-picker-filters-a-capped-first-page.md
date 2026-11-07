### A picker filters a capped first page

- **What happened:** The editor's `[[` link suggestions loaded the first 200 notes, with their Markdown, and filtered them in the browser; in a large notebook every later note was unreachable.
- **Root cause:** Link suggestions filtered a capped list on the client instead of searching the notebook on the server.
- **Error class:** A picker filters a capped first page
- **Guard:** Tests: Notebooks `note-link-autocomplete.test.ts` requires the typed text to reach the server and links a note beyond the first page; `note-titles.integration.test.ts` puts the exact title first among 20,000 matches. Convention: a picker over notebook content searches titles on the server.
