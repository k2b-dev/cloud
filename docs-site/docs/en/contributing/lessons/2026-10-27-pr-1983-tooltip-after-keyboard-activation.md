### A delayed tooltip consumed Escape after cancelling a keyboard move

- **What happened:** WebKit cancelled a Kanban move, but the next Escape did not reach the workspace. The focused grip's tooltip consumed it instead.
- **Root cause:** Pointer activation dismissed the shared tooltip and cancelled its opening timer; keyboard activation did neither. The grip cancelled the move before the delayed hint opened. That timer could then open the tooltip between the two Escape presses, so tooltip dismissal consumed the second Escape.
- **Error class:** Pointer and keyboard activation leave different delayed feedback state and keyboard ownership.
- **Guard:** The Kanban browser suite freezes the clock to exercise both an already open hint and a pending hint. Space must dismiss or cancel it; Escape cancels the move without reaching the workspace, and the next Escape reaches the workspace with focus still on the grip. Shared UI behavior tests cover Space and Enter with a local handler that stops propagation, and preserve first-Escape tooltip dismissal.
