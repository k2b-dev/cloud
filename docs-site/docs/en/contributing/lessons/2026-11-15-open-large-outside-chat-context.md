### "Open large" drew a view outside the chat it belonged to

- **What happened:** Every view file Gustav showed opened large as "This view is no longer available", while the same view stood in the chat.
- **Root cause:** "Open large" mounted its panel through `dialogCore` in a root of its own. There the chat's context was missing, so the view found no file address and reported itself unavailable; with a context it would have loaded the file a second time.
- **Error class:** Content rendered in a detached root that depends on context from where it was opened.
- **Guard:** The large view is the `@k2b/ui` Lightbox, rendered inside the view that opens it, with the data the chat already holds (`createCloudViewFile`). `approval-scenes.browser.test.ts` and `view-block.browser.test.ts` open a chart, key figures and a view-file table large, find their content, count one file load and check that the focus returns to the button.
