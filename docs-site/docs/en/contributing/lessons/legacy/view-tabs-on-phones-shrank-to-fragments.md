### View tabs on phones shrank to fragments

- **What happened:** On a phone, a Mail mailbox showed its views as "Nee 12" and "Assig 5" beside the head actions ([#1550](https://github.com/k2b-dev/cloud/issues/1550)).
- **Root cause:** `.k2b-view-tabs__item` could shrink (`flex: 0 1 auto` with a 2.75rem floor), so the views shrank and faded their labels before the scrolling strip had anything to scroll.
- **Error class:** Navigation truncation drift.
- **Guard:** `packages/ui/src/actions/view-tabs.browser.test.ts` checks in Chromium and WebKit, at 390 px and in a 640 px head, that no view label is clipped and no tab is narrower than its content. It also checks that the current view lies in view in the server frame, after hydration, after an in-place change, and after a resize, and that a focused tab is never under the edge fade, also in RTL. Tabs now keep their content width at any width, and the strip scrolls.
