### A phone head gave way with its menu still in it

- **What happened:** On the phone, inside Cloud's shell, a v2 head with a path collapsed to no height even when it held a menu "…" or other kept actions. In Gustav's chat the menu "…" (In diesem Chat, rename, archive) and "Neuer Chat" lay under the content and could not be pressed. On a list screen, the head's "Neuer Chat" stayed in the hidden head beside the floating one, so the layout check counted two primary actions.
- **Root cause:** The rule for a head under a host search (`data-k2-host-search`) collapsed every head whose start holds a path. It did not look at the head's end, although its comment meant a head that shows only where the page stands. The twin of `Workspace primary` in the head had no mark, so the rule could not tell it from a real action. The layout check counted a button clipped by a head of no height as shown. The app harnesses did not set the host mark, so their phone tests passed while the page was broken.
- **Error class:** A rule keyed on what a part holds at its start, while what it holds at its end decides whether it may go.
- **Guard:**
  - A head gives way only when its end holds nothing but the search and the twin marked `Button floats`. On the phone that twin leaves the head.
  - The layout check counts a control inside a box of no height that clips as hidden.
  - `packages/ui/src/v2/phone-head-actions.browser.test.ts` covers, in Chromium and WebKit: a chat head with "…", a head without a start with "…", a list head with its twin, the host's search, and the desktop.
  - The Assistant's v2 harness sets `data-k2-host-search` as Cloud's layout does.
