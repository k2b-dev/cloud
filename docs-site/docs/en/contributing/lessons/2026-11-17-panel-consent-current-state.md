### Panel consent controls must read the controller's current state

- **What happened:** The panel menu could offer an enabled consent checkbox while the slot was saving. A withdrawal could then leave context sharing enabled.
- **Root cause:** The menu copied controller state from document notifications, and its persistent checkbox received a plain saving value. Holding those notifications reproduced both the enabled row during a save and the withdrawal wait after a stale answer requested another grant.
- **Error class:** Stale state in persistent interactive controls.
- **Guard:** `panel-menu.behavior.test.tsx` checks saving changes on the same checkbox element. `panel-slot.browser.test.ts` delays consent responses and state notifications, checks the open menu during saving, and verifies live delivery, withdrawal, and suppression of subsequent updates. The menu reads the controller's reactive state directly; its disabled getter follows that state.
