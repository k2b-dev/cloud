### History workspace tests targeted the previous details outline

- **What happened:** Three Files workspace behavior tests failed after merging the shared details outline: the modified-date assertion read the new header timestamp, and both folder-count tests queried a removed element.
- **Root cause:** The tests retained selectors and presentation expectations from the old inspector. Main deliberately added a header timestamp and replaced the standalone folder count with a contents list whose total appears only for complete pages. Only one test froze the clock despite the suite sharing dated fixtures.
- **Error class:** UI tests retaining obsolete presentation assumptions after a merge.
- **Guard:** `history-workspace.behavior.test.tsx` targets the modified fact and Contents section, checks loading, error, retry, loaded rows and complete-page totals, and freezes time to the fixture date before every test. Partial pages never claim a total; README lookup results are not counted twice.
