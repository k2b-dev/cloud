### A sheet that moves by transform is measured before it stands

- **What happened:** The map dialog phone test failed in merge-queue runs of unrelated PRs (#3365, #3344, #3366, #3367): the point 9 px above the sheet's grip hit the dialog instead of the grip, while the test passed locally (#3391).
- **Root cause:** After a pin tap raises the sheet to its middle height, the sheet moves by transform over `--k2b-motion-sheet` (#2981). The test waited only for the detail heading and then read the grip's box and `elementFromPoint`; under CI load it read them mid-move.
- **Error class:** Geometry read after a content condition instead of after the motion that places the element.
- **Guard:** The test now awaits `settled(page)` before it reads the grip, as the `settle-reads` rule asks for every geometry read after a state change; the rule could not see this read because the preceding `waitForFunction` counted as a wait.
