### Keep a menu click while its controller loads

- **What happened:** A click on the panel's server-rendered menu button did
  nothing when the lazy controller had not loaded. Investigation started with
  #3621, whose CI run timed out waiting for the absent **Share context** row.
- **Root cause:** The server-rendered button had no click listener and was replaced when
  the controller mounted. A fixture that holds the controller import confirms
  the lost click. This is a confirmed product defect; it does not establish
  the cause of the CI failure, which happened after the controller had handled
  **Allow**. Holding the consent response leaves the menu open, retains its
  row, and enables the checkbox after saving. Context becomes allowed only
  after saving finishes, so an additional save wait would be redundant.
- **Error class:** Lost interaction during lazy controller loading.
- **Guard:** `panel-slot.browser.test.ts` holds the controller import until
  after a click on the server-rendered button, then requires the menu to open. A second
  test holds the consent response, checks the retained row's disabled state,
  then withdraws context and proves later updates remain blocked. The shell
  retains the early click and opens the mounted menu after loading succeeds.
