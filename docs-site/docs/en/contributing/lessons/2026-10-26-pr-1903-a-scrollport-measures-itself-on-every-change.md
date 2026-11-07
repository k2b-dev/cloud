### A scrollport measures itself on every change

- **What happened:** Marking fifty chats read froze Chat for seconds: the fade on the sidebar read its scroll height after each row's change, and every read laid the page out again.
- **Root cause:** A scrollport measures itself on every change.
- **Error class:** A scrollport measures itself on every change
- **Guard:** Test: UI `scroll-fade.behavior.test.ts` counts one measurement per frame for fifty separate row changes and one immediate measurement on request.
