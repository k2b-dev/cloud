### Chart measure labels must not replace the accessible name

- **What happened:** A Pulse Pareto panel had comparison measure labels but no accessible chart name matching its panel title.
- **Root cause:** Pareto uses `labels` for its two measure names. The Pulse host avoided the shared inspector labels override without supplying the chart title as the accessible-name fallback.
- **Error class:** A host confuses domain labels with interaction labels when composing a shared component.
- **Guard:** `Dashboard.browser.test.ts` finds the Pareto chart by its panel title on desktop and phone, then checks that its keyboard tooltip still names both SQL measures.
