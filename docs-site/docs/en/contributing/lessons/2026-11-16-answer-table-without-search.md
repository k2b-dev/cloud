### A table in Gustav's answer had no search in its head

- **What happened:** A table Gustav made of tasks showed only Copy and Maximize in its head; the search the concept puts there was missing.
- **Root cause:** A view table showed its search only when the view file set `search: true`, and Gustav rarely sets it. The head of a block in an answer is the chat's, not the file's.
- **Error class:** A required part of a shared head depended on each writer asking for it.
- **Guard:** In an answer every table's head has its search, with the foot that names the matches; outside an answer the view's own `search` still decides. `view-block.browser.test.ts` finds the search on a view that names none, at 1280 and 390.
