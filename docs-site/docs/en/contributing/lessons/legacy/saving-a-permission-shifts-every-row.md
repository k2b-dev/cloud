### Saving a permission shifts every row

- **What happened:** Changing one permission replaced every row's picker with a shorter badge until saving finished ([#1277](https://github.com/k2b-dev/cloud/issues/1277)).
- **Root cause:** The editor used pending state to choose between a control and a badge.
- **Error class:** A control swaps to a different element during a pending state and shifts layout.
- **Guard:** Permission editor behavior tests retain picker identity during grants, updates, and revokes and check failure recovery; Chromium tests compare row and control boxes before, during, and after an update at phone and desktop widths and check that keyboard focus returns to the changed picker. Convention: [Pending states keep the control](/en/ui/getting-started#pending-states-keep-the-control).
