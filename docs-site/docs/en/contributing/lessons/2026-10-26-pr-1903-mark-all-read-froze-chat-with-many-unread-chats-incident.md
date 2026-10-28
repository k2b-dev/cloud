### "Mark all read" froze Chat with many unread chats

- **What happened:** After confirming "Mark all read" with fifty unread chats, Chat stayed busy for several seconds; the browser test for it timed out on `main` (#1789).
- **Root cause:** The sidebar's scroll fade measured the scrollport on every mutation inside it. Each measurement forced a layout of the whole page, once per changed row.
- **Error class:** A scrollport measures itself on every change.
- **Guard:** Content changes are measured once per frame; scrolling and changes to the scrollport itself measure at once. A reader that needs the edges in the same frame, such as the note editor's scroll margins, calls `measureScrollFade(element)`. `scroll-fade.behavior.test.ts` counts the measurements for fifty separate row changes, and the Chat browser test passes again.
- **Follow-up:** The first version also delayed scrolling and the note editor's reads, so `fade-scroll-margins.browser.test.ts` in Notebooks and the UI's `scroll-fade.behavior.test.tsx` failed in CI, not in the Chat checks that were run. Measuring the first change of each frame at once fixed those but brought back the Chat Info layout shift (#1871) in 3 of 3 runs, against 0 of 2 with measuring per frame, so readers now ask for a measurement instead. Error class: a shared primitive changes and only one consumer is tested.
