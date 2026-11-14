### A pending plain draft creation enabled a different place's composer

- **What happened:** Combining the first-save usability fix with place chats left the composer enabled after switching from a plain draft with a pending create to an empty place. Sending there could silently fail while the unrelated create was still loading.
- **Root cause:** The editing exception checked only whether any draft creation was pending. Place creation correctly refused to join that plain request, so the enabled control did not have a runnable send path.
- **Error class:** An in-flight operation's UI exception outlives the context that owns it.
- **Guard:** `AssistantPlace.browser.test.ts` holds a plain draft's first-save request, switches to an empty place, and checks that its composer waits for the unrelated creation. The test fails before the context check. Plain first-save editing and sending remain covered by `ChatPanel.browser.test.ts`.
