### Opening a Cloud tab kept the privacy screen on

- **What happened:** With the privacy screen on in one Cloud tab, a newly opened or reloaded Cloud page covered itself at once, although the person had just opened it.
- **Root cause:** On install, every page asked the other tabs for their state (`hello`) and covered when one answered `on`. The page load itself never counted as the person's input, so a test even required the new tab to start covered.
- **Error class:** An idle detector counts only in-page input and misses navigation as the person's activity, or counts browser-driven loads (background tabs, prerender, automatic reloads) as activity.
- **Guard:** The browser tests in `packages/cloud/src/ssr/privacy-screen.browser.test.ts` cover a new tab that lifts every tab and restarts the idle time without covering for a moment, a background tab that lifts only when shown, and a covered page that stays covered after a reload.
