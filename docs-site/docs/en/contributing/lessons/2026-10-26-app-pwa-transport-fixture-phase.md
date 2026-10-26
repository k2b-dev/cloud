### Exercise the intended phase before expiring a transport fixture

- **What happened:** under shared-host load, a body-deadline test expired before receiving headers, and a CLI guard test exhausted its budget across four process launches.
- **Root cause:** the transport assertion assumed wall-clock timing implied a particular protocol phase; independent CLI cases, viewports, launcher sessions and several real PIN derivations shared one test deadline; cold CLI plugin builds also consumed the first command test's behavior budget.
- **Error class:** test scheduling depended on host load.
- **Guard:** trigger the caller deadline from the first response body chunk, control only the Web Push transport deadline after two real body chunks, keeping HTTP progress and the test runner on real timers, and split independent CLI, viewport, launcher and PIN scenarios into separate tests with real setup hooks, preserving every rejection, no-write, crypto and layout assertion. CLI fixtures compile in per-module setup hooks before command assertions. Independent reads of the settled explorer table run together; its row cap and frame assertions remain unchanged.

