### Wait for the calculated route after choosing an address

- **What happened:** The map ambiguity browser test failed in WebKit with no recorded `calculate` call after the candidate list disappeared (#3598).
- **Root cause:** Choosing a candidate immediately sets the dialog to loading, which removes its listbox before the action request reaches the server. Waiting for that removal does not wait for route calculation. Holding the action request in real WebKit reproduced the empty call list; releasing it and waiting for the route's stop list passed.
- **Error class:** Synchronizing an asynchronous assertion on an intermediate UI state.
- **Guard:** `map-widget.browser.test.ts` waits for the calculated route's stop list before asserting the recorded `calculate` call. The existing assertions still check that selecting a candidate alone makes no Geo calls and that route options preserve their scope.
