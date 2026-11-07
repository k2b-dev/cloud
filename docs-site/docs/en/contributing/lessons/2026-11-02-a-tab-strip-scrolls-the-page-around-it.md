### A tab strip scrolled the page around it when it mounted

- **What happened:** Administration › Code › approvals opened a version 156 px below its header at 1280 px and further on a phone. The first reasons and rights were out of view before the person touched anything.
- **Root cause:** `Tabs` kept its selected tab visible with `scrollIntoView({ block: "nearest", inline: "nearest" })`. That call scrolls every scrollable ancestor until the tab is in view, so a file strip below the fold of a detail column moved the column. `SettingsModal` used the same call for its section rail.
- **Error class:** A control that keeps its own selection in view uses `scrollIntoView` and so scrolls containers it does not own.
- **Guard:** `revealInScroller` in `@k2b/ui` scrolls only the strip's own scroller; `Tabs` and `SettingsModal` use it. `tabs.browser.test.ts` mounts both strips with the selected item past the edge, below the fold of a scrolling panel in a scrolling page, and fails when the page or the panel moves.
