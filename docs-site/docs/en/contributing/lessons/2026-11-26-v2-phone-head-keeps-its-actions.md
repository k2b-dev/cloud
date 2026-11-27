### A phone head hid or collapsed actions nobody could reach

- **What happened:** On the phone a v2 head hid every action without `keep`, and inside Cloud's shell a head with a path collapsed to no height even when it held a menu "…". In Gustav's chat the menu "…" (In diesem Chat, rename, archive) and "Neuer Chat" could not be pressed. On a list screen the head's "Neuer Chat" stayed in the hidden head beside the floating one, so the layout check counted two primary actions.
- **Root cause:** Head actions left the phone by default, with `keep` as the exception, and the host-search rule collapsed every head whose start held a path without looking at its end. The twin of `Workspace primary` and a detail's close × had no mark, so no rule could tell them from real actions. The layout check counted a button clipped by a head of no height as shown.
- **Error class:** A default that hides controls, with an opt-in to keep them, while what a head holds at its end decides whether anything may go.
- **Guard:**
  - Every head control stays on the phone. Only two marked controls leave the head there: `Button floats` (the twin of `Workspace primary`) and `Button closes` (a detail's close × beside its `Pane back`).
  - A head gives way only when its end holds nothing but the search and the `floats` twin.
  - Below 600 px a head control with a symbol keeps only the symbol, so a title beside the actions keeps its room.
  - The layout check counts a control inside a box of no height that clips as hidden. "the primary action is hidden at this width" does not fire while an open detail shows its way back.
  - `packages/ui/src/v2/phone-head-actions.browser.test.ts` covers a chat head with "…", a head without a start with "…", a list head with its twin, the host's search, an open detail on the phone, and the desktop.
