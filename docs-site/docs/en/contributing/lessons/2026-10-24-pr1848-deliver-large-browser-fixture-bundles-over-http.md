### Deliver large browser fixture bundles over HTTP

- **What happened:** Assistant Sidebar and WaitingStrip fixtures exceeded existing startup deadlines after their dependency graph grew.
- **Root cause:** The fixtures serialized large compiled bundles through Playwright's inline-script or route-fulfillment channel. An instrumented Sidebar comparison reproduced the timeout with a 17.5 MB inline bundle and passed with the same bundle served over HTTP.
- **Error class:** Fixture asset transport consumes the interaction budget.
- **Guard:** Sidebar and WaitingStrip serve compiled assets over local HTTP while retaining module loading, isolated API fixtures, layout assertions and unchanged deadlines in both browser engines.
