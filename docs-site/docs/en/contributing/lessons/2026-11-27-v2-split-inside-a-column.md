### An open detail ran past the window at 1024 px: the workspace did not count a split inside a column

- **What happened:** In Files and the pairing screen at 1024 px, the open detail ended 3 to 13 px past the window. W1b also saw the grip of its line stand 1 px off a line that looked 3 px wide.
- **Root cause:** Their workspace holds one column (with a status row) whose content is a `Pane.Split` of a list (400 px) and a detail (320 px). The workspace asks only its top columns what they need, and that column said 400 px. So the sidebar stayed a column at 1024 px, and the split inside had 13 px too little. Solid's context also passes through a dialog's portal, so a split in a dialog could have counted toward the column behind it.
- **Error class:** A measure of room that counts only the parts at its own level, where the parts that need the room stand one level deeper, or stand over the page.
- **Guard:** A split inside a column now tells that column what its panes need beside each other, at any depth. A detail counts nothing there, because its room is the workspace's declared `detail`, open or closed. A context column that gives way counts nothing either. Dialogs and popover panels end that counting. `packages/ui/src/v2/nested-split.browser.test.ts` checks four things:
  - the Files shape, a split without a detail, and a record's detail with its info column, from 1024 to 1920 px: nothing runs past the window, and every grip stands centred on a 1 px line;
  - a split without a detail turns the sidebar into a drawer at 1024 px;
  - a nested detail opens and closes without moving the sidebar, from 800 to 1440 px;
  - a split in an open dialog asks for no room.
  It failed first at 1024 px (1037 px), and the open/close and dialog cases failed before their fixes.
