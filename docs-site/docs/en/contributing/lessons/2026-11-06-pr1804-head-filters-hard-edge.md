### Head filters hid chips behind a hard edge

- **What happened:** In Spaces at 1194 px and on iPad at 834 px, the filter chips in the workspace head stopped at a hard edge, so nothing showed that more chips followed.
- **Root cause:** The filter group scrolls sideways with a hidden scrollbar, but unlike the view strip it was not marked as a fading scrollport.
- **Error class:** A sideways scroller without an overflow cue cuts its last controls at a hard edge, so people cannot tell that more follow.
- **Guard:** `workspace-head-row.browser.test.ts` ("chips that scroll on their own row fade at the edge that hides them") checks the fade at both ends of an overflowing filter row.
