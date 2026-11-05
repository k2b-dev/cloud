### A phone chat picker failed before opening

- **What happened:** The Notebook writer and phone system-chat picker tests intermittently failed during their initial load in the merge queue, before opening a picker.
- **Root cause:** The phone back link's enlarged touch target covers the browser's initial pointer position. Its background and text color hover transitions can start during the frames after `settled()` samples running animations. The helper correctly rejects those newly started transitions; the workspace has already mounted.
- **Error class:** Behavior tests depending on incidental animation timing.
- **Guard:** The shared `load()` helper in `ChatSystemChats.browser.test.ts` explicitly requests reduced motion for every context, following the Testing page's convention for suites that do not assess motion. The existing phone overview and Notebook writer flows exercise that helper; `settled()` keeps rejecting newly started finite animations elsewhere.
